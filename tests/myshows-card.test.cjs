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
    for (const rating of [0, null, 4, 5]) {
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
    for (const rating of [-1, 6, 3.5, '4']) {
        const { value, calls } = state([]);
        ctx.myShowsCardSaveRating(value, rating, (_, error) => assert.ok(error));
        assert.equal(calls.length, 0);
    }
    const { value, calls } = state(['network-error']);
    ctx.myShowsCardSaveRating(value, 4, (_, error) => assert.ok(error));
    assert.equal(calls.length, 1);
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
