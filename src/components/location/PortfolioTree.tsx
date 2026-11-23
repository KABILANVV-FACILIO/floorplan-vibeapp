import { useEffect, useRef, useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { activateOnKey } from '../../lib/keyboard';
import type { FloorSearchHit } from '../../lib/types';
import styles from './PortfolioTree.module.css';
import search from './SpacesList.module.css';

interface FlatNode {
  id: string;
  name: string;
  pad: number;
  kind: 'site' | 'building' | 'floor';
  hasChildren: boolean;
  expanded: boolean;
  active: boolean;
  badge: string | null;
  drillIn: boolean;
  onClick: () => void;
}

/**
 * The portfolio switcher. Two things about it follow from the org's size (431 buildings, 587
 * floors): the tree loads ONE LEVEL AT A TIME — a site's buildings on expand, a building's floors on
 * expand — and there is a search box, because scrolling a tree that big to find a floor is not a
 * plan. Typing swaps the tree for a flat hit list; picking a hit loads and expands its path, then
 * selects the floor, so the tree underneath shows where you landed.
 *
 * Only `loading…` and `no plan` are badged. An expanded node with nothing under it already reads
 * as empty; labelling it "no floors" / "no buildings" just adds noise to a tree of 431 buildings.
 *
 * The search asks the org once the typing pauses (SEARCH_PAUSE_MS), not on every keystroke: each
 * letter used to be its own `floor` list request, so typing a building's name spent a dozen calls
 * of the user's budget on queries nobody was waiting for. The box itself answers every keystroke —
 * it shows what is typed, and the hits list says "Searching…" until the search has been sent and
 * answered.
 */
const SEARCH_PAUSE_MS = 300;

export function PortfolioTree() {
  const { state, actions } = useFloorplanData();
  // What is in the box. The app's query (state.portfolioSearch) follows it after the pause.
  const [text, setText] = useState(state.portfolioSearch);
  const textRef = useRef(text);
  textRef.current = text;
  /** The query last handed to the app — so a change the app makes ITSELF can be told apart. */
  const sent = useRef(state.portfolioSearch);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read at send time: `actions` is rebuilt on every render.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // The app clears the query itself when a hit is opened (revealSearchHit), and the box must show
  // that. Only a value the box didn't send is taken back into it, so a slow round-trip can never
  // overwrite letters typed since.
  useEffect(() => {
    if (state.portfolioSearch === sent.current) return;
    sent.current = state.portfolioSearch;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setText(state.portfolioSearch);
  }, [state.portfolioSearch]);

  function send(q: string) {
    timer.current = null;
    sent.current = q;
    void actionsRef.current.setPortfolioSearch(q);
  }

  function onType(q: string) {
    setText(q);
    if (timer.current) clearTimeout(timer.current);
    // Emptied: straight back to the tree, nothing to ask the org.
    if (!q.trim()) send(q);
    else timer.current = setTimeout(() => send(q), SEARCH_PAUSE_MS);
  }

  // Leaving with a search still waiting sends it, as typing it always did.
  useEffect(
    () => () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      void actionsRef.current.setPortfolioSearch(textRef.current);
    },
    []
  );

  const query = text;
  const searching = query.trim().length > 0;
  // Typed, but not yet asked — or asked and not yet answered.
  const pending = query !== state.portfolioSearch || state.portfolioSearching;

  const items: FlatNode[] = [];
  if (!searching) {
    for (const site of state.portfolio) {
      const siteExpanded = !!state.expanded[site.id];
      const siteLoading = !!state.treeLoading[site.id];
      items.push({
        id: site.id,
        name: site.name,
        pad: 8,
        kind: 'site',
        hasChildren: true,
        expanded: siteExpanded,
        active: false,
        badge: siteLoading ? 'loading…' : null,
        drillIn: false,
        onClick: () => void actions.expandNode(site.id),
      });
      if (!siteExpanded) continue;
      for (const building of site.buildings ?? []) {
        const buildingExpanded = !!state.expanded[building.id];
        const buildingLoading = !!state.treeLoading[building.id];
        items.push({
          id: building.id,
          name: building.name,
          pad: 24,
          kind: 'building',
          hasChildren: true,
          expanded: buildingExpanded,
          active: false,
          badge: buildingLoading ? 'loading…' : null,
          drillIn: false,
          onClick: () => void actions.expandNode(building.id),
        });
        if (!buildingExpanded) continue;
        for (const floor of building.floors ?? []) {
          // A floor "has a plan" if the static portfolio flag says so OR an actual floorplan is
          // known for it (uploaded this session, or listed from the file store at boot).
          const hasPlan = !!floor.hasPlan || !!state.floorsWithPlans[floor.id];
          items.push({
            id: floor.id,
            name: floor.name,
            pad: 42,
            kind: 'floor',
            hasChildren: false,
            expanded: false,
            active: state.floorId === floor.id,
            badge: hasPlan ? null : 'no plan',
            drillIn: hasPlan,
            onClick: () => {
              actions.selectFloor(floor.id);
              actions.setNavView('spaces');
            },
          });
        }
      }
    }
  }

  async function openHit(hit: FloorSearchHit) {
    await actions.revealSearchHit(hit);
    actions.selectFloor(hit.floorId);
    actions.setNavView('spaces');
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.label}>Choose a floor</div>
      <div className={search.searchBox} style={{ margin: '0 8px 6px' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={search.searchIcon}>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          className={search.searchInput}
          placeholder="Search floors or buildings"
          value={query}
          onChange={(e) => onType(e.target.value)}
          aria-label="Search floors"
        />
      </div>

      {searching ? (
        <div className={styles.list}>
          {pending && state.portfolioSearchResults.length === 0 && <div className={styles.row} style={{ color: 'var(--ink-500)' }}>Searching…</div>}
          {!pending && state.portfolioSearchResults.length === 0 && (
            <div className={styles.row} style={{ color: 'var(--ink-500)' }} role={state.portfolioSearchFailed ? 'alert' : undefined}>
              {state.portfolioSearchFailed === 'busy'
                ? 'Facilio is busy — search again in a minute.'
                : state.portfolioSearchFailed === 'error'
                  ? 'Couldn’t search floors — try again.'
                  : <>No floors match “{query.trim()}”.</>}
            </div>
          )}
          {state.portfolioSearchResults.map((hit) => (
            <div
              key={hit.floorId}
              className={[styles.row, state.floorId === hit.floorId ? styles.rowActive : ''].join(' ')}
              style={{ paddingLeft: 8 }}
              role="button"
              tabIndex={0}
              aria-current={state.floorId === hit.floorId ? 'true' : undefined}
              onClick={() => void openHit(hit)}
              onKeyDown={activateOnKey(() => void openHit(hit))}
              // The whole path: two floors can share a name, and the site and building line is the
              // first thing cut off in a narrow panel.
              data-tip={[hit.siteName, hit.buildingName, hit.floorName].filter(Boolean).join(' › ')}
            >
              <FloorGlyph />
              <span className={styles.name}>
                {hit.floorName}
                <span style={{ display: 'block', font: '400 11px/1.3 var(--font-sans)', color: 'var(--ink-500)' }}>
                  {[hit.siteName, hit.buildingName].filter(Boolean).join(' › ')}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.list}>
          {items.map((n) => (
            <div
              key={n.id}
              className={[styles.row, n.active ? styles.rowActive : ''].join(' ')}
              style={{ paddingLeft: n.pad }}
              // Tab to a row, Enter or Space to open it — a site or building expands, a floor loads.
              role="button"
              tabIndex={0}
              aria-expanded={n.hasChildren ? n.expanded : undefined}
              aria-current={n.active ? 'true' : undefined}
              onClick={n.onClick}
              onKeyDown={activateOnKey(n.onClick)}
              data-tip={n.name}
              data-tip-overflow=""
            >
              {n.hasChildren && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.chevron} style={{ transform: `rotate(${n.expanded ? 90 : 0}deg)` }}>
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
              {n.kind === 'site' && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={styles.typeIcon}>
                  <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
              )}
              {n.kind === 'building' && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={styles.typeIcon}>
                  <rect x="4" y="2" width="16" height="20" rx="1" />
                  <path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01" />
                </svg>
              )}
              {n.kind === 'floor' && <FloorGlyph />}
              <span className={styles.name} data-tip-measure="">{n.name}</span>
              {n.badge && <span className={styles.badge}>{n.badge}</span>}
              {n.drillIn && (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FloorGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z M2 12l10 5 10-5 M2 17l10 5 10-5" />
    </svg>
  );
}
