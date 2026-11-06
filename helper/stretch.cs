// SexyVal helper: display modes for stretched resolution, a crash watchdog, and a tiny allow-listed
// command runner used by the elevated scheduled task (Boost tweaks that need admin).
// Built with the .NET Framework C# compiler that ships with Windows (scripts/build-helper.mjs).
// It never touches the Valorant process: no handles, no injection, no memory access.
//
//   stretch.exe list                                  monitors + modes, JSON
//   stretch.exe apply <device> <w> <h> <hz> [--dry-run]
//   stretch.exe restore <device> <w> <h> <hz> <fixedOutput> [--dry-run]
//   stretch.exe foreground                            exe name of the foreground window's process
//   stretch.exe watchdog <pid> <stateFile>            restores native if <pid> dies while stretched
//   stretch.exe run <commandFile> <resultFile> [--dry-run]   allow-listed reg/sc/powercfg/schtasks lines
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class Native
{
    public const int ENUM_CURRENT_SETTINGS = -1;
    public const int DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000, DM_DISPLAYFIXEDOUTPUT = 0x20000000;
    public const int DMDFO_DEFAULT = 0, DMDFO_STRETCH = 1, DMDFO_CENTER = 2;
    public const int DISP_CHANGE_SUCCESSFUL = 0;
    public const int DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x1, DISPLAY_DEVICE_PRIMARY_DEVICE = 0x4;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public int dmFields;
        public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DISPLAY_DEVICE
    {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplayDevices(string device, int index, ref DISPLAY_DEVICE dd, int flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr param);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hwnd, out int pid);

    public static DEVMODE NewMode()
    {
        DEVMODE dm = new DEVMODE();
        dm.dmDeviceName = new string('\0', 32);
        dm.dmFormName = new string('\0', 32);
        dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        return dm;
    }
}

static class Json
{
    public static string Str(string s)
    {
        StringBuilder b = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }
}

static class Program
{
    static bool dryRun;

    static int Main(string[] args)
    {
        List<string> a = new List<string>(args);
        dryRun = a.Remove("--dry-run");
        try
        {
            string cmd = a.Count > 0 ? a[0] : "";
            if (cmd == "list") { Console.WriteLine(List()); return 0; }
            if (cmd == "apply" && a.Count >= 5) { Console.WriteLine(Apply(a[1], Int(a[2]), Int(a[3]), Int(a[4]))); return 0; }
            if (cmd == "restore" && a.Count >= 6) { Console.WriteLine(Restore(a[1], Int(a[2]), Int(a[3]), Int(a[4]), Int(a[5]))); return 0; }
            if (cmd == "foreground") { Console.WriteLine(Foreground()); return 0; }
            if (cmd == "watchdog" && a.Count >= 3) { Watchdog(Int(a[1]), a[2]); return 0; }
            if (cmd == "run" && a.Count >= 3) { return Run(a[1], a[2]); }
            Console.WriteLine("{\"ok\":false,\"error\":\"usage: list | apply <device> <w> <h> <hz> | restore <device> <w> <h> <hz> <fixed> | foreground | watchdog <pid> <state> | run <cmd> <result> [--dry-run]\"}");
            return 2;
        }
        catch (Exception e)
        {
            Console.WriteLine("{\"ok\":false,\"error\":" + Json.Str(e.Message) + "}");
            return 1;
        }
    }

    static int Int(string s) { return int.Parse(s, System.Globalization.CultureInfo.InvariantCulture); }

    static string ModeJson(Native.DEVMODE m)
    {
        return "{\"w\":" + m.dmPelsWidth + ",\"h\":" + m.dmPelsHeight + ",\"hz\":" + m.dmDisplayFrequency + ",\"fixedOutput\":" + m.dmDisplayFixedOutput + "}";
    }

    static string List()
    {
        StringBuilder sb = new StringBuilder("{\"ok\":true,\"dryRun\":" + (dryRun ? "true" : "false") + ",\"monitors\":[");
        bool first = true;
        for (int i = 0; ; i++)
        {
            Native.DISPLAY_DEVICE dd = new Native.DISPLAY_DEVICE();
            dd.cb = Marshal.SizeOf(dd);
            if (!Native.EnumDisplayDevices(null, i, ref dd, 0)) break;
            if ((dd.StateFlags & Native.DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) == 0) continue;
            Native.DISPLAY_DEVICE mon = new Native.DISPLAY_DEVICE();
            mon.cb = Marshal.SizeOf(mon);
            string name = Native.EnumDisplayDevices(dd.DeviceName, 0, ref mon, 0) ? mon.DeviceString : dd.DeviceString;
            Native.DEVMODE cur = Native.NewMode();
            Native.EnumDisplaySettings(dd.DeviceName, Native.ENUM_CURRENT_SETTINGS, ref cur);
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"device\":").Append(Json.Str(dd.DeviceName)).Append(",\"name\":").Append(Json.Str(name)).Append(",\"adapter\":").Append(Json.Str(dd.DeviceString));
            sb.Append(",\"primary\":").Append((dd.StateFlags & Native.DISPLAY_DEVICE_PRIMARY_DEVICE) != 0 ? "true" : "false");
            sb.Append(",\"current\":").Append(ModeJson(cur)).Append(",\"modes\":[");
            HashSet<string> seen = new HashSet<string>();
            bool f2 = true;
            for (int k = 0; ; k++)
            {
                Native.DEVMODE m = Native.NewMode();
                if (!Native.EnumDisplaySettings(dd.DeviceName, k, ref m)) break;
                if (m.dmBitsPerPel != 32) continue;
                string key = m.dmPelsWidth + "x" + m.dmPelsHeight + "@" + m.dmDisplayFrequency;
                if (!seen.Add(key)) continue;
                if (!f2) sb.Append(',');
                f2 = false;
                sb.Append("{\"w\":").Append(m.dmPelsWidth).Append(",\"h\":").Append(m.dmPelsHeight).Append(",\"hz\":").Append(m.dmDisplayFrequency).Append('}');
            }
            sb.Append("]}");
        }
        return sb.Append("]}").ToString();
    }

    static string Change(string device, int w, int h, int hz, int fixedOutput, string verb)
    {
        Native.DEVMODE dm = Native.NewMode();
        if (!Native.EnumDisplaySettings(device, Native.ENUM_CURRENT_SETTINGS, ref dm)) throw new Exception("unknown display " + device);
        string before = ModeJson(dm);
        dm.dmPelsWidth = w;
        dm.dmPelsHeight = h;
        dm.dmDisplayFrequency = hz;
        dm.dmDisplayFixedOutput = fixedOutput;
        dm.dmFields = Native.DM_PELSWIDTH | Native.DM_PELSHEIGHT | Native.DM_DISPLAYFREQUENCY | Native.DM_DISPLAYFIXEDOUTPUT;
        if (dryRun)
            return "{\"ok\":true,\"dryRun\":true,\"verb\":" + Json.Str(verb) + ",\"device\":" + Json.Str(device) + ",\"before\":" + before + ",\"wanted\":{\"w\":" + w + ",\"h\":" + h + ",\"hz\":" + hz + ",\"fixedOutput\":" + fixedOutput + "}}";
        // Flags 0: change the mode for this session only (not saved), so a reboot always comes back native.
        int r = Native.ChangeDisplaySettingsEx(device, ref dm, IntPtr.Zero, 0, IntPtr.Zero);
        if (r != Native.DISP_CHANGE_SUCCESSFUL && fixedOutput != Native.DMDFO_DEFAULT)
        {
            // Some drivers refuse the scaling field outright; retry the mode alone so the caller can see it.
            dm.dmFields &= ~Native.DM_DISPLAYFIXEDOUTPUT;
            r = Native.ChangeDisplaySettingsEx(device, ref dm, IntPtr.Zero, 0, IntPtr.Zero);
        }
        Native.DEVMODE now = Native.NewMode();
        Native.EnumDisplaySettings(device, Native.ENUM_CURRENT_SETTINGS, ref now);
        bool modeOk = now.dmPelsWidth == w && now.dmPelsHeight == h;
        return "{\"ok\":" + (r == 0 && modeOk ? "true" : "false") + ",\"verb\":" + Json.Str(verb) + ",\"result\":" + r + ",\"before\":" + before + ",\"readback\":" + ModeJson(now) +
               ",\"stretched\":" + (now.dmDisplayFixedOutput == Native.DMDFO_STRETCH ? "true" : "false") + "}";
    }

    static string Apply(string device, int w, int h, int hz) { return Change(device, w, h, hz, Native.DMDFO_STRETCH, "apply"); }

    static string Restore(string device, int w, int h, int hz, int fixedOutput) { return Change(device, w, h, hz, fixedOutput, "restore"); }

    static string Foreground()
    {
        int pid;
        Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out pid);
        string name = "";
        try { name = Process.GetProcessById(pid).ProcessName; } catch { }
        return "{\"ok\":true,\"process\":" + Json.Str(name) + "}";
    }

    /** state file lines: key=value (stretched, device, w, h, hz, fixed). Written by SexyVal. */
    static Dictionary<string, string> ReadState(string file)
    {
        Dictionary<string, string> d = new Dictionary<string, string>();
        foreach (string line in File.ReadAllLines(file))
        {
            int i = line.IndexOf('=');
            if (i > 0) d[line.Substring(0, i).Trim()] = line.Substring(i + 1).Trim();
        }
        return d;
    }

    static void Watchdog(int pid, string stateFile)
    {
        try { Process.GetProcessById(pid).WaitForExit(); } catch { }
        Thread.Sleep(1500); // a clean quit restores by itself and rewrites the state file first
        if (!File.Exists(stateFile)) return;
        Dictionary<string, string> s = ReadState(stateFile);
        string v;
        if (!s.TryGetValue("stretched", out v) || v != "1") return;
        Console.WriteLine(Restore(s["device"], Int(s["w"]), Int(s["h"]), Int(s["hz"]), Int(s["fixed"])));
        File.WriteAllText(stateFile, "stretched=0\r\nrestoredBy=watchdog\r\n");
    }

    // ---------------- elevated command runner ----------------
    // The command file is written by SexyVal (user-writable), and this may run elevated, so every line is
    // checked against a narrow allow-list: only the exact registry keys, services and power commands the
    // Boost tweaks need. Anything else is refused.
    static readonly string[] RegKeys = {
        @"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\VALORANT-Win64-Shipping.exe\PerfOptions",
        @"HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers",
    };
    static readonly string[] Services = { "WSearch", "DoSvc" };

    static bool Allowed(string exe, string[] args, out string why)
    {
        why = "";
        string e = exe.ToLowerInvariant();
        if (e == "reg.exe")
        {
            if (args.Length < 2 || Array.IndexOf(new[] { "query", "add", "delete" }, args[0].ToLowerInvariant()) < 0) { why = "reg verb"; return false; }
            if (Array.IndexOf(RegKeys, args[1]) < 0) { why = "reg key"; return false; }
            for (int i = 2; i < args.Length; i++)
            {
                string x = args[i];
                if (x == "/v") { i++; if (i >= args.Length || (args[i] != "CpuPriorityClass" && args[i] != "HwSchMode")) { why = "reg value"; return false; } }
                else if (x == "/t") { i++; if (i >= args.Length || args[i] != "REG_DWORD") { why = "reg type"; return false; } }
                else if (x == "/d") { i++; if (i >= args.Length || !Regex.IsMatch(args[i], "^[0-9]{1,2}$")) { why = "reg data"; return false; } }
                else if (x != "/f") { why = "reg flag " + x; return false; }
            }
            return true;
        }
        if (e == "sc.exe")
        {
            if (args.Length == 2 && Array.IndexOf(new[] { "query", "stop", "start" }, args[0]) >= 0 && Array.IndexOf(Services, args[1]) >= 0) return true;
            why = "sc";
            return false;
        }
        if (e == "schtasks.exe")
        {
            if (args.Length == 4 && args[0] == "/Delete" && args[1] == "/TN" && args[2] == @"SexyVal\Helper" && args[3] == "/F") return true;
            why = "schtasks";
            return false;
        }
        why = "program";
        return false;
    }

    static int Run(string commandFile, string resultFile)
    {
        StringBuilder outp = new StringBuilder();
        foreach (string raw in File.ReadAllLines(commandFile))
        {
            if (raw.Trim().Length == 0) continue;
            string[] parts = raw.Split('\t');
            string exe = parts[0];
            string[] args = new string[parts.Length - 1];
            Array.Copy(parts, 1, args, 0, args.Length);
            string why;
            if (!Allowed(exe, args, out why)) { outp.Append("-1\t").Append(Convert.ToBase64String(Encoding.UTF8.GetBytes("refused: " + why))).Append("\r\n"); continue; }
            if (dryRun) { outp.Append("0\t").Append(Convert.ToBase64String(Encoding.UTF8.GetBytes("dry-run: " + raw.Replace('\t', ' ')))).Append("\r\n"); continue; }
            ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, exe));
            StringBuilder argLine = new StringBuilder();
            foreach (string x in args) argLine.Append(argLine.Length > 0 ? " " : "").Append(x.IndexOf(' ') >= 0 ? "\"" + x + "\"" : x);
            psi.Arguments = argLine.ToString();
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            using (Process p = Process.Start(psi))
            {
                string so = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
                p.WaitForExit(20000);
                outp.Append(p.ExitCode).Append('\t').Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(so))).Append("\r\n");
            }
        }
        File.WriteAllText(resultFile + ".tmp", outp.ToString());
        if (File.Exists(resultFile)) File.Delete(resultFile);
        File.Move(resultFile + ".tmp", resultFile);
        return 0;
    }
}
