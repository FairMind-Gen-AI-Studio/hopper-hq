# Scranton HQ — M3b "Motion" design

Date: 2026-10-13
Status: validated design, pre-implementation
Builds on: `2026-10-09-scranton-hq-design.md` (§10 scene, §13 testing) and `2026-10-13-m3a-detail-design.md` (§4 scene v2)

## 1. Scope

M3b makes the floor move. A state change is seen as a robot walking somewhere, not read from a label (design §10).

**In M3b:**
- **A fixed floor plan.** Desks, meeting rooms and lounge seats are furniture that is always there; sessions take seats and leave them. The plan changes only when it grows, and it grows only upward. This replaces the M2 rule "one island per checkout, one desk per session", so the islands' wrap rule (F18) is gone.
- **Walking on state changes**: an A* path on the floor's grid between the elevator, desks, meeting rooms and the lounge. Elevator arrivals and departures.
- **Ambient animation at rest**: typing, waving, the jetpack bob, a pulsing needs badge.
- **Scale**: instancing of the fixed furniture, and tag decluttering on crowded floors.

**Out of scope:**
- standing tables and armchairs as further seat kinds (the seat model leaves room for them);
- the first-person walk mode;
- tmux-pane teammates (X-N1) and reading launch scripts outside `S/workflows/scripts` (B-M7);
- cloud sessions;
- instancing robots, unless the measurement in §7 requires it;
- diffing floor updates on the wire.

## 2. The floor plan

### 2.1 Pieces

One cell is one metre. x grows east, y grows south (as today).

- **Desk**: 2×2 cells, as today. Its `chair` is on its `north` or `south` edge, and the monitor sits on the opposite edge.
- **Pod**: 4 desks in 2×2, back to back. The monitors meet in the middle, and each chair opens onto an aisle outside the pod. Each pod has a rug, with a 1-cell pad around the desks, and a placard. A pod is 6×6 cells.
- **Block**: 2 pods side by side with an `AISLE` (2 cells) between them: 8 desks in 14×6 cells.
- **Core**: the elevator and plants on the north wall, top-left, as today.
- **Lounge**: a strip along the south wall under the blocks, 14×4 cells, with couches and beanbags. It has `LOUNGE_SEATS` = 8 seats.
- **Meeting wing**: rooms of 8×6 cells (as in M3a) east of the blocks, `AISLE` away.
  - Rooms 1–2 stack north to south in the first column.
  - Rooms 3–4 stack in a second column, `AISLE` further east.
  - A room's door is in the middle of its west wall.

### 2.2 Sizes

- **Base plan**: 1 block (8 desks), 1 room column (2 rooms) and the lounge. That makes a 28×20 floor.
- **Each further block** adds 8 cells of height. The lounge moves down with the blocks; the width does not change.
- **The second room column** makes the floor 38 wide.
- **Caps**: at most `BLOCKS_MAX` = 4 blocks (32 desks) and `ROOMS_MAX` = 4 rooms.

Order and positions are fixed:
- Desk index order is block, then pod (west, east), then desk (north row west to east, south row west to east).
- Desk ids are `p<pod>-<n>`.
- Pod ids are `p<pod>`.
- Room slots are numbered 0–3.

### 2.3 Growth

A floor's plan is two numbers: `blocks` (1–4) and `roomCols` (1–2).

- **Blocks**: a block is added when a session arrives, no desk is free and no dormant session can be moved (§3).
- **Rooms**: `roomCols` becomes 2 when a third run is live at once.
- **No shrinking**: neither number goes down while the floor has a session.
- **Reset**: when the floor empties, its row is deleted, as today, so the plan starts again at the base the next time the floor opens.
- **Persistence**: the plan is kept in the `floors` table (§3.4), so it survives daemon restarts.
- **Camera**: the floor changes size only when it grows. A camera at its home view frames the new floor. A camera the user moved keeps its place and its zoom, within the limits. This settles F-N1.

## 3. Seating

### 3.1 Where it runs

Seating is a pure function owned by the server: `seat(previous, views, now) -> next`, per floor.

- **It advances when the scene is read.** Time-derived states (done→idle after 4 h, idle→dormant) exist only at read time. The scene hub's 15 s tick re-reads the scene, so seating has to move on every read.
  - The collector's scene reads (`render`, `scene`, `floor`) first advance the stored seating once, from the views they read. They then build from it.
  - `render` builds the façade and the watched floors from one reading, so they always agree.
  - `seat` is idempotent: run twice on the same views it changes nothing.
  - The collector stores the result next to `firstSeen` and marks the floor dirty for persistence when it changes.
- **Builds only read it**, the way they read `firstSeen`. The same views and seating in any order give the same scene.
- Every tab therefore sees the same seats, and a reload reshuffles nothing.

### 3.2 Rules

Departures are applied before arrivals. Arrivals are handled in start order (`startedAt`, then id).

**Desks:**
1. A session keeps its desk from arrival until it ends or leaves the floor. A feature change moves it to another floor: it leaves the old floor by the elevator and arrives on the new one.
2. A new session takes, in this order:
   - a free desk in a pod where a session of its checkout (island key: worktree root, or cwd outside git) already sits;
   - else the first desk of an empty pod;
   - else the first free desk, in desk index order.
3. With no free desk:
   - it takes the desk of the dormant session on this floor that has been dormant longest. That session loses its desk and goes through rule 2 when it wakes.
   - With no dormant session either, the plan grows by a block.
   - At `BLOCKS_MAX`, the session waits for a free desk. It is listed in the floor's `unseated` (§4), so it still appears in the attention bar and the floor panel. Waiting sessions take freed desks in start order.
4. **Dormant**: the robot leaves by the elevator. The desk stays reserved, with its monitor off and the session's name on a nameplate. A dormant session with no desk takes a free one if there is one, but never takes another session's desk and never grows the plan. Sessions that are not dormant are seated first.
5. **Ended**: the desk is freed at once.

**Lounge:** an idle session with a desk takes the first free lounge seat, in the order it became idle, and keeps it while it stays idle. With the lounge full, it rests at its desk in the M2 `resting` pose.

**Rooms:**
- A live run takes the first free room slot and keeps it until it ends, so rooms no longer shift when an earlier one closes.
- Runs are keyed by host and run, deduped by run id as in M3a.
- Beyond the slots, runs are counted in `roomsMore`.

**Pod look:**
- **Rug**: the repo's colour while every occupant shares one repo, otherwise neutral.
- **Placard**:
  - the checkout (repo, branch, worktree flag, path) while all occupants share one;
  - else the repo name, if they share only that;
  - else nothing.

### 3.3 First start

On the first M3b start, each floor gets the smallest plan that seats its sessions that are not dormant (at most `BLOCKS_MAX`). Sessions are seated in start order by the rules above, so dormant ones take the desks left over.

### 3.4 Persistence

- **Schema**: the `floors` table gains a nullable `plan` column holding JSON: `blocks`, `roomCols`, desk occupants by index, lounge seats and room slots.
- **Migration**: `CREATE TABLE IF NOT EXISTS` does not add a column to an existing table, so the store adds `plan` with `ALTER TABLE` when it is missing. A test opens a database with today's schema and rows and upgrades it.
- **When it is written**: on the dirty-floor path that already writes `first_seen`.
- **Bad data**: a missing or malformed value is rebuilt from the views, as on first start.

## 4. Scene (SCENE_VERSION 3)

The server says where each robot should be. The renderer works out how it gets there. No positions or paths go over the wire.

`FloorDetail` v3:

- `size` and `core`, as today.
- `pods: Pod[]` replaces `islands`. A pod has:
  - `id`, `rect`;
  - `color`: a repo slot, or null;
  - `placard`: `{ repo, branch, worktree, path } | null`;
  - `desks`: always its 4 desks.
- `Desk` is `{ id, rect, chair: 'north' | 'south', occupant: Occupant | null }`.
  - `Occupant` carries the v2 `Desk` fields except `rect` and `away`: session id, name, title, state, since, reason, activity, agentsRunning, summary, interns, internsMore, runs, location, pane, focusable and robot.
  - It also carries `at: Place`.
  - A dormant occupant has `robot: null`.
- `Place` is one of:
  - `{ kind: 'desk' }`;
  - `{ kind: 'lounge', seat }`;
  - `{ kind: 'room', slot }`: the host at the head of its run's table while `in_meeting`. A host whose run has no room (counted in `roomsMore`) stays at `desk`;
  - `{ kind: 'gone' }`: dormant.

  `at` is the target the renderer walks the robot to.
- `lounge: { rect, seats }`.
- `roomSlots: GridRect[]`: every room of the plan, by slot, empty or not.
- `rooms: MeetingRoom[]`: the live runs that have a room. Each `MeetingRoom` gains its `slot`.
  - An empty slot has its door closed and its lights dimmed. The door is closed only visually: the walk grid treats every door as open, so it does not change when rooms open and close.
  - `MeetingRoom.host` is dropped. The host's robot is the desk occupant's robot, with `at` pointing at the room.
- `roomsMore` (as in v2).
- `unseated: Occupant[]`: the floor's sessions without a desk. These are a dormant session whose desk another session took, and sessions waiting at the cap (§3.2). They have no robot on the floor. The floor panel lists them, and the façade counts them in `counts`, but they have no window.

**Façade**:
- One window per desk of the plan. `FacadeWindow` becomes `{ sessionId: string | null, state: ShownState | null }`.
- Free desks are dark windows, so from outside a floor shows its size and how full it is.
- The session count is the sum of `counts`, which covers unseated sessions too, not the number of windows.

**Routes and selection**:
- `#/floor/<key>/desk/<sessionId>` is unchanged. A free desk cannot be selected.
- The floor panel still groups desks by checkout, now worked out from the occupants.

**Wire size (D-M3)**:
- A test caps the JSON size of the fullest floor (§7).
- If the floor goes over the cap, the per-desk run history leaves the floor payload, and the desk panel fetches it when it opens.

**Version mismatch**: a tab opened before the upgrade already shows the reload notice when the version differs.

## 5. Motion

All of it lives in the renderer, as pure modules with their own tests plus a thin per-frame driver.

### 5.1 Grid and paths

- **Walk grid**: built from `FloorDetail` at half-cell resolution, as in `prototypes/floor-3d-mockup.html`.
  - Blocked: desks, outer walls, room glass (not doors), room tables, lounge furniture and plants.
  - It is rebuilt only when the layout signature changes, which now means only when the plan grows.
- **Path**: A* over 8 neighbours, with no corner cutting and an octile heuristic. The path is then string-pulled into straight runs by line-of-sight checks.
  - When a target changes mid-walk, the robot re-paths from where it stands.
  - When the plan grows mid-walk, every walker re-paths on the new grid.
  - Robots do not avoid each other.
- **Place → spot**: a pure function, extending today's seat and stand spots with lounge seats, room head seats and an elevator spot just inside the doors.

### 5.2 What moves when

| Change | Movement |
|---|---|
| A session arrives on the floor | Out of the elevator, walks to its desk. |
| `working`, `no_signal` | Seated at its desk. |
| `needs_you`, `done` | Stands up and steps beside the chair. |
| Host `in_meeting` | Walks to the head of its room's table through the door; walks back when it leaves the meeting. |
| `idle` with a lounge seat | Walks to the seat; back to its desk at the next prompt. |
| `dormant`, `ended`, a floor change | Walks to the elevator and leaves. |
| A workflow agent starts or finishes | Walks from the elevator to its seat, and back. Departures in a burst are spaced about 150 ms apart. |
| An intern starts or finishes | Flies in a straight line at hover height from the elevator to its desk, and back. |

**Interns' hover spot**: behind a back-to-back desk is the other desk, so interns hover higher, above the desk's back edge, clear of the monitors.

**Elevator**: the doors open for each arrival or departure and close about 1.2 s after the last one.

**Speed**:
- About 1.6 m/s walking and 2.2 m/s flying.
- A trip lasts at most about 5 s, so long paths are walked faster.

**One robot per session.**
- Today a host in a meeting is two objects: a hidden desk robot and a separate host robot in the room. In M3b each session has exactly one robot, keyed by session id, and it walks between desk, room, lounge and elevator.
- Workflow agents are keyed by agent id and interns by agent id within their desk.

**Coordinates**: room robots are no longer children of their room's group. Every robot lives in floor coordinates, so it can walk between rooms, desks and the elevator. Rooms no longer move.

**Seats stay put.** Room seats and intern spots follow the same rule as desks: first come keeps the seat. If they were taken by list index, as today, every agent after one that finishes would shift a seat and walk. The renderer keeps the seat map for each room and each desk's interns:
- a running agent keeps its seat until it finishes;
- a new agent takes the first free seat;
- agents beyond the seats are not drawn, as in M3a.

### 5.3 When nothing walks

- **First sight**: on floor open, on reload, and when a hidden tab becomes visible, every robot is already in place. Only changes seen while watching animate. A floor update that follows a stream reconnect counts as first sight.
- **Reduced motion**: robots jump to their place, as today, with no ambient loops.
- **Tests**: a `motion=off` query parameter, read once at load, gives the same behaviour for e2e and screenshots. Unit tests drive motion through an injected clock.

## 6. Frames, ambient animation and shadows

### 6.1 Three rates

1. **Still**: nothing is drawn, as today. This applies under reduced motion with nothing moving, and to a floor with no robot.
2. **Full**: every animation frame while something moves: a walk, the elevator doors, a camera tween or move, or a held arrow key.
3. **Ambient**: about 20 fps otherwise, while the tab is visible and the floor has a robot.

Nothing is drawn while the tab is hidden or the WebGL context is lost, as today.

### 6.2 Ambient loops

The loops are small, and each robot's phase is set by a hash of its id, so the robots do not move in step:

| Robot | Loop |
|---|---|
| `working`, workflow agents | Arms typing. |
| `needs_you` | A waving hand and a pulsing badge. |
| `done` | The held paper sways a little. |
| `no_signal` | Head down, slow breathing. |
| `idle` in the lounge | Relaxed breathing. |
| Interns | The jetpack bobs. |

### 6.3 Shadows

- **At rest**: robots cast real shadows.
- **Walking**: a walker stops casting and shows a soft contact disc under it.
- **Shadow map updates**: the map is drawn once when a walk starts and once when it ends. Walks that start or end in the same frame share one draw.
- **Ambient loops** do not update the shadow map.
- **Interns** cast no real shadow, only a faint disc (F-M4).

### 6.4 What follows a moving robot

- Its tag, the selection ring and picking follow it. Labels are placed again on every drawn frame where a robot moved.
- The camera does not follow.

## 7. Scale

### 7.1 Measure first

A unit test builds the fullest floor:
- 4 blocks, every desk taken;
- 4 full rooms;
- a full lounge;
- 3 interns per desk.

It counts visible meshes, draw calls and shadow casters, and the JSON size of the floor. These counts are deterministic. The implementation plan sets the caps from the first measurement.

### 7.2 Instancing

- **Instanced**: desks, chairs, monitors, room tables and chairs, couches, beanbags and plants. Each is one `InstancedMesh` per geometry and material.
- **Rebuilt** only when the plan grows.
- **Monitor on or off**: set by the instance's colour.
- **Picking**: maps `instanceId` to the desk id. Room glass takes no clicks (F-M2).
- **Robots are not instanced.** They have pivoted limbs and animate one by one. They keep sharing geometries and materials, and are reconsidered only if the measurement misses its cap after the furniture is instanced.

### 7.3 Tags

- **Priority**: selected, then `needs_you`, then `done`, then room names, then `working`, then other states, then pod placards.
- **Zoomed out** (below a pixels-per-metre threshold): only the selected tag, `needs_you`, `done` and room names show.
- **Zoomed in**: every tag shows. When two tags' screen rectangles overlap, the lower-priority one hides. The check runs only when labels move, over a few dozen tags at most.
- **Free desks** have no tag.
- **Dormant desks** have no tag either, only the nameplate on the desk (a small canvas-texture plate, drawn when zoomed in).

## 8. Demo

The demo script exercises every movement:
- elevator arrivals and departures;
- trips to the lounge and to a meeting;
- a floor that reaches its ninth session and grows a block;
- workflow runs that overlap, so a room is always open (D-M5).

## 9. Testing

**Pure functions:**
- **Seating**: affinity, taking a dormant desk, growth, reset when empty, waiting at the cap (listed in `unseated`), first start, persistence round trip, and a time-derived transition (idle→dormant) advancing seating on the tick path only.
- **Plan layout**: a snapshot per size (1–4 blocks, 1–2 room columns).
- **Grid and A***:
  - at every plan size, a path exists from the elevator to every desk, lounge seat and room seat;
  - no path crosses a blocked cell;
  - consecutive points of a string-pulled path are in line of sight.
- **Place → spot**: state → place → spot.
- **Tag priority and overlap.**
- **Choice of frame rate** from the view's state.

**Renderer** (happy-dom, injected clock):
- a walker's position over time;
- re-pathing mid-walk;
- one robot per session across desk, room and lounge;
- room seats and intern spots that stay put when an earlier agent finishes;
- jumping into place when hidden, under reduced motion and with `motion=off`;
- the number of shadow-map draws per walk;
- instance counts and picking by `instanceId`;
- the §7.1 counts.

**Daemon**: after a restart, seats, plan size and room slots are unchanged.

**e2e**:
- the smoke run uses `motion=off`;
- one case with motion on waits until a robot has arrived. While anything moves, the stage carries a `data-moving` attribute.

## 10. Risks

- **Startup burst**: after a long gap, many robots could stream out of the elevator at once. Rule §5.3 (first sight, reconnects) prevents it. A reconnect test pins it.
- **Ambient frames cost** about 20 frames a second for as long as a floor is open and visible. The counts in §7.1 bound each frame. A tab that loses focus but stays visible keeps drawing.
- **Overlapping robots**: with no avoidance, two robots can cross through each other in an aisle. This is accepted, because walks are short and rare.
- **Repo-coloured rugs**: a pod's rug colour changes as occupants come and go. Rugs carry the repo only while it is shared, and robot bodies always do.
- **Seating state** now lives in the collector and in the database, beside the state machine. A malformed row is rebuilt from the views (§3.4), and seating stays a pure function.
