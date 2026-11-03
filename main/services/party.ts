import type { PartyView } from '../../shared/features';
import type { RiotApi } from '../riot/api';
import type { AssetService } from './assets';
import type { CatalogService } from './catalog';
import type { NameService } from './history';
import { assetUrl } from './assets';
import { HttpError } from '../riot/http';

const enc = encodeURIComponent;

/** Party + matchmaking. Every mutation is a manual button press from the UI. */
export class PartyService {
  view: PartyView = { status: 'idle', eligibleQueues: [], members: [], requests: [], preferredPods: [], isOwner: false };

  constructor(
    private readonly api: RiotApi,
    private readonly assets: AssetService,
    private readonly catalog: CatalogService,
    private readonly names: NameService,
  ) {}

  private partyId(): string {
    if (!this.view.partyId) throw new Error('No active party');
    return this.view.partyId;
  }

  async refresh(): Promise<PartyView> {
    try {
      const pp = await this.api.partyPlayer();
      const partyId = pp.status === 200 ? pp.json?.CurrentPartyID : null;
      if (!partyId) {
        this.view = { ...this.view, status: 'none', partyId: undefined, members: [], error: 'No party: Valorant must be open (party service only knows online players)' };
        return this.view;
      }
      const p = await this.api.party(partyId);
      if (p.status !== 200 || !p.json) {
        this.view = { ...this.view, status: 'none', partyId: undefined, members: [], error: `Party ${p.status}` };
        return this.view;
      }
      const j = p.json;
      const me = this.api.session.puuid;
      const members: any[] = Array.isArray(j.Members) ? j.Members : [];
      await this.names.waitFor(members.map((m) => m.Subject).filter(Boolean));
      const cards = this.catalog.catalog.cards;
      this.view = {
        status: 'ready',
        partyId,
        state: j.State,
        queueId: j.MatchmakingData?.QueueID,
        eligibleQueues: Array.isArray(j.EligibleQueues) ? j.EligibleQueues : [],
        accessibility: j.Accessibility === 'OPEN' || j.Accessibility === 'CLOSED' ? j.Accessibility : undefined,
        inviteCode: j.InviteCode || undefined,
        preferredPods: Array.isArray(j.MatchmakingData?.PreferredGamePods) ? j.MatchmakingData.PreferredGamePods : [],
        queueEntryTime: j.QueueEntryTime,
        isOwner: members.some((m) => m.Subject === me && m.IsOwner === true),
        members: members.map((m) => {
          const n = this.names.get(m.Subject);
          const card = cards.find((c) => c.id === String(m.PlayerIdentity?.PlayerCardID ?? '').toLowerCase());
          return {
            puuid: m.Subject,
            name: n?.name,
            tag: n?.tag,
            cardIcon: assetUrl(card?.icon),
            level: Number(m.PlayerIdentity?.AccountLevel) || undefined,
            rank: this.assets.rank(m.CompetitiveTier),
            isOwner: m.IsOwner === true,
            isReady: m.IsReady === true,
            isMe: m.Subject === me,
            pings: (Array.isArray(m.Pings) ? m.Pings : []).map((x: any) => ({ pod: String(x.GamePodID ?? ''), ping: Number(x.Ping) || 0 })),
          };
        }),
        requests: (Array.isArray(j.Requests) ? j.Requests : []).map((r: any) => ({ id: String(r?.ID ?? ''), by: r?.RequestedBySubject, subjects: Array.isArray(r?.Subjects) ? r.Subjects : [] })),
      };
    } catch (e) {
      this.view = { ...this.view, status: 'error', error: (e as Error).message };
    }
    return this.view;
  }

  /** Whitelisted actions -> documented endpoints only. */
  async action(name: string, arg?: any): Promise<PartyView> {
    try {
      await this.send(name, arg);
    } catch (e) {
      throw new Error(friendlyPartyError(name, arg, e));
    }
    return this.refresh();
  }

  private async send(name: string, arg?: any): Promise<void> {
    const me = this.api.session.puuid;
    const pid = () => this.partyId();
    switch (name) {
      case 'queue':
        await this.api.partyAction('POST', `/parties/v1/parties/${pid()}/queue`, { queueId: String(arg) });
        break;
      case 'start':
        await this.api.partyAction('POST', `/parties/v1/parties/${pid()}/matchmaking/join`);
        break;
      case 'stop':
        await this.api.partyAction('POST', `/parties/v1/parties/${pid()}/matchmaking/leave`);
        break;
      case 'accessibility':
        await this.api.partyAction('POST', `/parties/v1/parties/${pid()}/accessibility`, { accessibility: arg === 'OPEN' ? 'OPEN' : 'CLOSED' });
        break;
      case 'code-generate':
        await this.api.partyAction('POST', `/parties/v1/parties/${pid()}/invitecode`);
        break;
      case 'code-disable':
        await this.api.partyAction('DELETE', `/parties/v1/parties/${pid()}/invitecode`);
        break;
      case 'join-code':
        await this.api.partyAction('POST', `/parties/v1/players/joinbycode/${enc(String(arg).trim())}`);
        break;
      case 'invite': {
        const m = /^(.+)#([^#]+)$/.exec(String(arg).trim());
        if (!m) throw new Error('Use Name#Tag');
        await this.api.partyAction('POST', `/parties/v1/parties/${pid()}/invites/name/${enc(m[1])}/tag/${enc(m[2])}`);
        break;
      }
      case 'request-join':
        await this.api.partyAction('POST', `/parties/v1/parties/${enc(String(arg))}/request`);
        break;
      case 'decline':
        await this.api.partyAction('POST', `/parties/v1/parties/${pid()}/request/${enc(String(arg))}/decline`);
        break;
      case 'kick':
      case 'leave':
        await this.api.partyAction('DELETE', `/parties/v1/players/${enc(String(name === 'leave' ? me : arg))}`);
        break;
      case 'ready':
        await this.api.partyAction('POST', `/parties/v1/parties/${pid()}/members/${me}/setReady`, { ready: !!arg });
        break;
      case 'refresh-pings':
        await this.api.partyAction('POST', `/parties/v1/parties/${pid()}/members/${me}/refreshPings`);
        break;
      default:
        throw new Error(`Unknown party action ${name}`);
    }
  }
}

/** Turns Riot's HTTP errors into a sentence that says what went wrong, instead of "HTTP 404 on /glz/...". */
function friendlyPartyError(name: string, arg: unknown, e: unknown): string {
  if (!(e instanceof HttpError)) return (e as Error)?.message ?? String(e);
  let riot = '';
  try {
    riot = String(JSON.parse(e.body)?.message ?? '');
  } catch {
    // body was not JSON
  }
  if (name === 'join-code' && (e.status === 404 || e.status === 400)) return `No party uses the code ${String(arg ?? '').trim().toUpperCase()}. Codes stop working when the owner disables them.`;
  if (name === 'invite' && e.status === 404) return `Couldn’t invite ${String(arg ?? '').trim()}: no online player with that Name#Tag.`;
  if (name === 'start' && e.status === 400) return `Can’t start the queue${riot ? `: ${riot}` : '. Check that everyone is ready and the queue is open to this party.'}`;
  return riot ? `Riot refused that (${e.status}): ${riot}` : `Riot refused that (HTTP ${e.status}).`;
}
