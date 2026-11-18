import asyncio
import json

from PIL import Image, ImageDraw
import pytest

from fullawake.capabilities.desktop_vision.game_watcher import (
    AWAY_SECONDS, EVENT_SECONDS, GameWatcher, WatchSession, load_profiles, measure_frame,
)

GAME = (11, 22, 'FixtureGame.exe', {'left': 0, 'top': 0, 'width': 200, 'height': 100})
ROIS = {'death': [.4, .1, .6, .2], 'timer': [.4, .2, .6, .3],
        'victory': [.35, .4, .65, .6], 'defeat': [.35, .4, .65, .6],
        'base': [.1, .8, .25, .95], 'minimap': [.8, .75, 1, 1]}


def fixture_marker(name, size):
    image = Image.new('RGB', size, '#111111')
    w, h = size
    box = (0, 0, w // 2, h - 1) if name == 'defeat' else (0, 0, w - 1, h // 2)
    ImageDraw.Draw(image).rectangle(box, fill='#eeeeee')
    return image


@pytest.fixture
def profiles(tmp_path):
    profile = {'timer': ROIS['timer']}
    for name, roi in ROIS.items():
        if name == 'timer':
            continue
        fixture_marker(name, (40, 20)).save(tmp_path / f'{name}.png')
        profile[name] = {'roi': roi, 'template': f'{name}.png'}
    path = tmp_path / 'profiles.json'
    path.write_text(json.dumps({GAME[2]: profile}), encoding='utf-8')
    return load_profiles(path)


def paint(scene='playing'):
    frame = Image.new('RGB', (200, 100), (190, 48, 10) if scene not in {'death', 'no_timer'} else (86, 86, 86))
    markers = {'death': ('death', 'timer'), 'no_timer': ('death',), 'win': ('victory',),
               'loss': ('defeat',), 'recall': ('base', 'minimap')}.get(scene, ())
    for name in markers:
        x0, y0, x1, y1 = (int(value * (200 if i % 2 == 0 else 100)) for i, value in enumerate(ROIS[name]))
        frame.paste(fixture_marker(name, (x1 - x0, y1 - y0)), (x0, y0))
    return frame


@pytest.mark.parametrize(('scene', 'kind', 'outcome', 'times'), [
    ('death', 'death', None, [2.5]), ('win', 'victory', 'win', [2.5, 5]),
    ('loss', 'victory', 'loss', [2.5, 5]), ('recall', 'recall', None, [2.5, 5, 7.5]),
])
def test_safe_window_is_a_single_transition(profiles, scene, kind, outcome, times):
    profile = profiles[GAME[2].casefold()]
    session = WatchSession(object(), GAME, profile)
    assert session.update(measure_frame(paint(), 0, profile)) is None
    for timestamp in times[:-1]:
        assert session.update(measure_frame(paint(scene), timestamp, profile)) is None
    sample = measure_frame(paint(scene), times[-1], profile)
    event = session.update(sample)
    assert (event.type, event.outcome, event.timestamp) == (kind, outcome, times[-1])
    assert event.snapshot_burst[-1] == times[-1] and len(session.frames) == 2
    assert session.permits(event, sample)
    assert not session.update(measure_frame(paint(scene), times[-1] + 2.5, profile))
    assert not session.permits(event, measure_frame(paint(), times[-1] + 3, profile))
    assert not session.update(measure_frame(paint(), times[-1] + 4, profile))
    assert not session.permits(event, sample)


def test_no_timer_no_result_on_movement_and_no_initial_base_cue(profiles):
    profile = profiles[GAME[2].casefold()]
    session = WatchSession(object(), GAME, profile)
    for time, frame in enumerate((paint(), paint('no_timer'), paint('win'))):
        assert not session.update(measure_frame(frame, time * 2.5, profile))
    moving = paint('win')
    ImageDraw.Draw(moving).rectangle((0, 0, 199, 39), fill='white')
    assert not session.update(measure_frame(moving, 7.5, profile))
    base = WatchSession(object(), GAME, profile)
    for time in range(5):
        assert not base.update(measure_frame(paint('recall'), time * 2.5, profile))


def test_recall_teleport_must_settle_before_stationary_duration_starts(profiles):
    profile = profiles[GAME[2].casefold()]
    session = WatchSession(object(), GAME, profile)
    arrived = paint('recall')
    ImageDraw.Draw(arrived).rectangle((0, 0, 199, 69), fill='white')
    assert not session.update(measure_frame(paint(), 0, profile))
    assert not session.update(measure_frame(arrived, 2.5, profile))
    assert not session.update(measure_frame(paint('recall'), 5, profile))
    assert not session.update(measure_frame(paint('recall'), 7.5, profile))
    assert not session.update(measure_frame(paint('recall'), 10, profile))
    assert session.update(measure_frame(paint('recall'), 12.5, profile)).type == 'recall'


def test_session_owner_lock_away_and_expiry(profiles):
    async def run():
        now, foreground, scene, locked = 0, GAME, 'playing', False
        watcher = GameWatcher(profiles, clock=lambda: now, probe=lambda: (foreground, {'locked': locked}),
                              capture=lambda **_: {'game': foreground, 'image': paint(scene)})
        owner, other = object(), object()
        events, ends = [], []

        async def tick():
            await watcher.tick(lambda _, event: events.append(event), lambda _, reason: ends.append(reason))

        session = await watcher.start(owner)
        assert session is not None and await watcher.start(other) is None
        await tick()
        now, scene = 2.5, 'death'
        await tick()
        event, = events
        assert watcher.event(other, event.id) == (None, None)
        assert await watcher.revalidate(session, event)
        now += EVENT_SECONDS
        assert not await watcher.revalidate(session, event)
        foreground = None
        await tick()
        assert not session.frames and watcher.session is session
        now += AWAY_SECONDS
        await tick()
        assert ends == ['away'] and watcher.session is None
        foreground = GAME
        assert await watcher.start(owner)
        foreground, locked = None, True
        await tick()
        assert ends == ['away', 'locked'] and watcher.session is None
        assert await watcher.start(owner) is None

    asyncio.run(run())
