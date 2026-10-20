# WindScore Android App Interface Design

Date: 2026-10-20

## Goal

Design an Android-first WindScore experience for phones and tablets used during practice and performance. The first release focuses on browsing the local dynamic-score library and playing scores. It does not provide score editing, accompaniment alignment, or export.

## Selected product structure

Use a three-item bottom navigation for **曲库**, **社区**, and **我的**. The library is the launch destination. Opening a song pushes a dedicated, immersive player screen; the player hides bottom navigation and keeps a top return control. Community and My remain lightweight destinations that return to the library through bottom navigation or Android Back.

Alternatives considered:

1. **Three-tab library app with immersive player (selected):** fast access to the three destinations and maximum score area during playback.
2. **A launch dashboard with separate feature cards:** familiar to the desktop home page, but adds a step before the primary task.
3. **Tablet master-detail split view:** keeps the library visible while viewing a score, but reduces score space and makes the tablet player differ from the phone player.

## Screen designs

### 1. Launch splash

Show the existing WindScore icon/wordmark, app name, and the slogan **“随时看谱，练习演出更从容”**. The splash is a loading transition, not a destination: remain visible while local library data initializes, then enter the library automatically. Do not require a tap or add a fixed delay after loading completes.

### 2. Library

The library screen is the default destination and the app's home. Its hierarchy is:

1. Search field at the top.
2. A favorites filter beside the search field. Active state limits results to favorites; inactive state shows all songs.
3. A single-column, pinyin-sorted song list.
4. Persistent bottom navigation: 曲库 / 社区 / 我的.

Search matches Chinese text, tone-insensitive full Mandarin pinyin, and pinyin initials against both the library name and score title. Search is case-insensitive and ignores spaces in pinyin queries. A no-results message includes the submitted query.

Each song row shows the song name and the score's available key, meter, and BPM. Future metadata (lyricist/composer, recommended timbre, and difficulty) is not shown as blank placeholders until the product has data for it. The star is a non-interactive favorite-state indicator. The ellipsis menu contains 收藏 / 取消收藏 and 删除. Deleting opens a confirmation that names the song before removal.

When the library is empty, show a direct **导入乐谱** action that opens the same `.wspack` import flow available from My > 曲库管理. On narrow screens the list fills the available width with comfortable side insets. On wider screens, keep a single column centered at a maximum content width of 760 CSS px rather than stretching rows across the tablet.

### 3. Player

Selecting a song opens the player immediately. The score occupies the space between the top bar and the bottom control area. The top bar contains a return-to-library control and song title. The player supports Jianpu and staff notation; Jianpu is the entry default and notation switching lives in Settings.

The bottom toolbar contains a seekable progress bar, a centered play/pause control, a replay-from-start control, and Settings. While playback is active, hide the bottom toolbar after five seconds without interaction. Paused playback keeps the toolbar visible. If the toolbar is hidden, the first screen tap reveals it; once visible, tapping the score moves the play position. The player keeps the display awake only while playback is active in the foreground.

Use the device's current orientation and available dimensions. Portrait and landscape both remain supported without forcing rotation. The score area can be pinched to zoom, scrolled vertically, and double-tapped to return to fitted width. On wider tablet screens, preserve the same single-score focus rather than showing a library split pane.

The Settings surface is a bottom sheet on phones and a centered compact dialog on tablets. It includes:

- Notation: Jianpu / staff.
- Audio source: automatic choice on entry (accompaniment when available, otherwise synthesized score), with a manual override.
- Display: font size, spacing, and cursor style.
- Score order: original / expanded repeats.
- Playback: transposition and speed.

Starting a song resets playback settings to defaults: score-defined font size and spacing, Jianpu, the default cursor style, zero semitone shift, and 1x speed. Scores with repeat structures start in expanded-repeat view. Audio source is chosen automatically for each song unless changed during that playback session.

The Android player does not expose editing, alignment, or export actions.

### 4. Community

Show a centered, static **“社区即将开放”** message. Keep the three-item bottom navigation visible with 社区 selected. Do not show sample posts or controls that imply active community functionality.

### 5. My

Show a static profile summary with a random numeric username generated on first launch and persisted locally, plus a **曲库管理** action. The profile does not create accounts or imply registration. Library management opens the Android system file picker for `.wspack` import and reports import progress and result.

If an imported song's name already exists, keep both entries and append the next available number, such as `歌名 (2)` or `歌名 (3)`. Never overwrite an existing library entry automatically.

## Navigation and responsive behavior

- Cold launch: Splash → Library.
- Library row: Player; Android Back or the top return control returns to Library.
- Bottom navigation switches between Library, Community, and My. Community and My both provide an immediate path back to Library.
- Use responsive CSS dimensions and safe-area insets rather than device-specific fixed canvases. Keep touch controls comfortably tappable and ensure the player toolbar does not cover score content.
- Library stays a centered single column on tablets. Player keeps the score as the primary full-screen content in both orientations.

## Scope and known implementation gap

The Android shell already launches the library page and bridges file selection into the system picker. The existing library search matches names/titles as text; pinyin query matching is new work. The selected Android scope excludes editor, alignment, and export.

## Design acceptance criteria

- A user can launch into the library, search by Hanzi/full pinyin/initials, filter favorites, import a package, and open a score without passing through a feature dashboard.
- Favorite status is visible at a glance, and only the ellipsis menu changes it.
- Deletion requires explicit confirmation; duplicate import preserves both copies with a numeric suffix.
- Playback has a clear seek, play/pause, replay, and settings path, with controls hiding and returning exactly as specified.
- The same navigation model works on phone and tablet; portrait and landscape preserve readable score content and reachable controls.
- Community is clearly marked as unavailable, and My remains explicitly local/static.

