const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the shipped functions without booting Lampa or accessing an account.
const source = fs.readFileSync(require.resolve('../' + (process.env.MYSHOWS_TEST_SOURCE || 'myshows.full.js')), 'utf8');
const code = source.slice(source.indexOf('    function myShowsCardMatch('), source.lastIndexOf('    function boot()'));
const ctx = vm.createContext({
    AUTHORIZATION: 'authorization2', API_URL: 'https://myshows.me/v3/rpc/',
    getCardIdentifiers: card => card,
    createJSONRPCRequest: (method, params) => JSON.stringify({ method, params }),
});
vm.runInContext(code, ctx);

function state(responses, overrides = {}) {
    const calls = [];
    const value = {
        token: 'fixture-only', id: 411, isMovie: true, alive: () => true,
        network: { silent(url, ok, fail, body, options) {
            calls.push({ url, ...JSON.parse(body), options });
            const response = responses.shift();
            if (response === 'network-error') fail();
            else ok(response);
        } }, ...overrides,
    };
    return { value, calls };
}

test('matches films and shows conservatively, preserving Cyrillic and release year', () => {
    const card = { title: 'Знахарь', year: 2023 };
    const rows = [{ movie: { id: 1, title: 'Знахарь', year: 1982 } }, { movie: { id: 2, title: 'Знахарь', year: 2023 } }];
    assert.equal(ctx.myShowsCardMatch(rows, card, true), 2);
    assert.equal(ctx.myShowsCardMatch([...rows, rows[1]], card, true), null);
    assert.equal(ctx.myShowsCardMatch([{ show: { id: 3, titleOriginal: 'FlashForward', year: 2009 } }], { originalName: 'FlashForward', year: 2009 }, false), 3);
    assert.equal(ctx.myShowsCardMatch([{ movie: { id: 1, title: 'Знахарь', year: 2023, imdbId: 123 } }], { ...card, imdbId: 'tt999' }, true), null);
});

test('reads an existing personal score, and distinguishes unrated from malformed/error responses', () => {
    for (const rating of [0, null, 4, 4.5, 5]) {
        const { value } = state([{ result: { rating } }]);
        ctx.myShowsCardLoadRating(value, (actual, error) => {
            assert.equal(error, null);
            assert.equal(actual, rating || null);
        });
    }
    for (const response of [{ result: {} }, { result: { rating: '4' } }, { error: { code: 401 } }, 'network-error']) {
        ctx.myShowsCardLoadRating(state([response]).value, (rating, error) => {
            assert.equal(rating, null);
            assert.ok(error);
        });
    }
});

test('saves films and shows using the right IDs and confirms the persisted score', () => {
    for (const isMovie of [true, false]) {
        const { value, calls } = state([{ result: true }, { result: { rating: 4 } }], { isMovie });
        ctx.myShowsCardSaveRating(value, 4, (rating, error) => {
            assert.equal(rating, 4);
            assert.equal(error, null);
        });
        assert.equal(calls[0].method, isMovie ? 'manage.RateMovie' : 'manage.RateShow');
        assert.deepEqual(calls[0].params, isMovie ? { movieId: 411, rating: 4 } : { id: 411, rating: 4 });
        assert.equal(calls[1].method, isMovie ? 'profile.Movie' : 'profile.Show');
        assert.equal(value.saving, false);
    }
});

test('removing a rating is confirmed as unrated, while stale readback is an error', () => {
    ctx.myShowsCardSaveRating(state([{ result: true }, { result: { rating: 0 } }]).value, 0, (rating, error) => {
        assert.equal(rating, null);
        assert.equal(error, null);
    });
    ctx.myShowsCardSaveRating(state([{ result: true }, { result: { rating: 2 } }]).value, 5, (rating, error) => assert.ok(error));
});

test('rejects invalid/unauthenticated writes, and does not retry an uncertain write', () => {
    for (const overrides of [{ token: '' }, { id: -1 }, { id: '411' }, { saving: true }]) {
        const { value, calls } = state([], overrides);
        ctx.myShowsCardSaveRating(value, 4, (_, error) => assert.ok(error));
        assert.equal(calls.length, 0);
    }
    for (const rating of [-1, 6, 3.25, '4']) {
        const { value, calls } = state([]);
        ctx.myShowsCardSaveRating(value, rating, (_, error) => assert.ok(error));
        assert.equal(calls.length, 0);
    }
    const { value, calls } = state(['network-error']);
    ctx.myShowsCardSaveRating(value, 4, (_, error) => assert.ok(error));
    assert.equal(calls.length, 1);
});

test('converts aggregate and personal scores to ten without inventing an unrated score', () => {
    assert.equal(ctx.myShowsCardScore(4.46), '8.9');
    assert.equal(ctx.myShowsCardScore(5), '10.0');
    assert.equal(ctx.myShowsCardScore(0), null);
    assert.equal(ctx.myShowsCardScore('4.46'), null);
    assert.equal(ctx.myShowsCardPersonalLabel(4.5), 'Моя оценка: ★ 9/10');
    assert.equal(ctx.myShowsCardPersonalLabel(5), 'Моя оценка: ★ 10/10');
    assert.equal(ctx.myShowsCardPersonalLabel(null), 'Не оценено');
    const { value, calls } = state([{ result: true }, { result: { rating: 4.5 } }]);
    ctx.myShowsCardSaveRating(value, 4.5, (rating, error) => { assert.equal(rating, 4.5); assert.equal(error, null); });
    assert.equal(calls[0].params.rating, 4.5);
});

test('late responses from a closed card or previous profile cannot update its UI', () => {
    let callback, alive = true, updates = 0;
    const { value } = state([], { alive: () => alive, network: { silent(url, ok) { callback = ok; } } });
    ctx.myShowsCardLoadRating(value, () => updates++);
    alive = false;
    callback({ result: { rating: 5 } });
    assert.equal(updates, 0);
});

test('API text is escaped before entering Lampa Select HTML templates', () => {
    assert.equal(ctx.myShowsCardEscape('<img onerror="alert(1)"> & test'), '&lt;img onerror=&quot;alert(1)&quot;&gt; &amp; test');
    assert.equal(ctx.myShowsCardText({ html: 'unexpected object' }), '');
});

test('async buttons join only their foreground card navigation without resetting focus', () => {
    const appended = [];
    let controller = 'full_start', current = true;
    ctx.Lampa = { Controller: {
        enabled: () => ({ name: controller }),
        collectionAppend: button => appended.push(button),
        collectionSet: () => assert.fail('must not reset the active navigation'),
    } };
    const button = { name: 'rating button' };
    const card = { current: () => current };
    ctx.myShowsCardRegisterButton(card, button);
    assert.deepEqual(appended, [button]);
    current = false;
    ctx.myShowsCardRegisterButton(card, button);
    current = true;
    controller = 'select';
    ctx.myShowsCardRegisterButton(card, button);
    assert.equal(appended.length, 1);
});

test('late status buttons do not hijack a menu or discard the new card controls', () => {
    vm.runInContext(source.slice(source.indexOf('    function createMyShowsButtons('), source.indexOf('    function updateButtonStates(')), ctx);
    Object.assign(ctx, { watch_icon: '', later_icon: '', remove_icon: '', cancelled_icon: '' });
    for (const foreground of [true, false]) for (const controller of ['full_start', 'select']) {
        const nodes = [], data = {};
        const container = {
            length: 1,
            data(key, value) { if (value !== undefined) data[key] = value; return data[key]; },
            find() { return nodes; }, append(node) { nodes.push(node); }, addClass() { return this; },
        };
        const activity = { render: () => ({ find: () => container }) };
        let appended = 0;
        ctx.$ = () => { const node = { on() { return node; }, is() { return true; } }; return node; };
        ctx.Lampa = {
            Activity: { active: () => ({ component: 'full', activity: foreground ? activity : {} }) },
            Controller: { enabled: () => ({ name: controller }),
                collectionSet: () => assert.fail('late status callback reset navigation'),
                collectionFocus: () => assert.fail('late status callback stole focus'),
                collectionAppend: items => { appended += items.length; },
            },
        };
        ctx.window = { Lampa: ctx.Lampa };
        ctx.createMyShowsButtons({ object: { activity }, data: { movie: {} } }, 'watching', false);
        assert.equal(nodes.length, 4);
        assert.equal(appended, foreground && controller === 'full_start' ? 4 : 0);
    }
});

test('poster requests are deduplicated, bounded, cached and never paint a reused card', () => {
    const requests = [];
    ctx.myShowsPosterCache = undefined;
    ctx.myShowsPosterPending = {};
    ctx.myShowsPosterQueue = [];
    ctx.myShowsPosterRetry = {};
    ctx.myShowsPosterActive = 0;
    ctx.Lampa = {
        Storage: { get: () => ({}), set() {} },
        Reguest: function() {
            this.timeout = () => {};
            this.silent = (url, ok, fail, body, options) => requests.push({ ok, fail, ...JSON.parse(body), options });
        },
    };
    ctx.document = { body: { contains: el => el.attached }, createElement: () => ({ dataset: {} }) };
    function poster(id, title) {
        const view = { badge: null, querySelector: () => view.badge,
            appendChild(node) { view.badge = node; node.remove = () => { view.badge = null; }; } };
        return { attached: true, card_data: { id, title, media_type: 'movie', year: 2024 }, view,
            querySelector: selector => selector === '.card__view' ? view : view.badge };
    }
    const a = poster(1, 'Film A'), duplicate = poster(1, 'Film A'), b = poster(2, 'Film B'), offscreen = poster(3, 'Film C');
    [a, duplicate, b, offscreen].forEach(ctx.queueMyShowsPosterRating);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.headers.authorization2, undefined);
    offscreen.attached = false;
    requests[0].ok({ result: [{ movie: { id: 101, title: 'Film A', year: 2024, rating: 4.46, voted: 100 } }] });
    assert.equal(a.view.badge.textContent, 'MS 8.9');
    assert.equal(duplicate.view.badge.textContent, 'MS 8.9');
    assert.equal(requests.length, 2);
    b.card_data.id = 99;
    requests[1].ok({ result: [{ movie: { id: 102, title: 'Film B', year: 2024, rating: 5 } }] });
    assert.equal(b.view.badge, null);
    const cached = poster(1, 'Film A');
    ctx.queueMyShowsPosterRating(cached);
    assert.equal(cached.view.badge.textContent, 'MS 8.9');
    assert.equal(requests.length, 2);
    ctx.myShowsPosterCache[ctx.myShowsPosterKey(a.card_data)].at = Date.now() - 86400001;
    const expired = poster(1, 'Film A');
    ctx.queueMyShowsPosterRating(expired);
    assert.equal(requests.length, 3);
    requests[2].fail();
    ctx.queueMyShowsPosterRating(expired);
    assert.equal(requests.length, 3);
    assert.equal(expired.view.badge, null);
    assert.equal(ctx.myShowsPosterKey({ id: 1, profile_path: '/person.jpg', media_type: 'movie' }), null);
    assert.notEqual(ctx.myShowsPosterKey(a.card_data), ctx.myShowsPosterKey({ ...a.card_data, title: 'Another Film' }));
});
