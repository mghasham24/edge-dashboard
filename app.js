    var SPORTS = [{
        key: 'basketball_nba',
        label: 'NBA'
    }, {
        key: 'basketball_wnba',
        label: 'WNBA'
    }, {
        key: 'baseball_mlb',
        label: 'MLB'
    }, {
        key: 'icehockey_nhl',
        label: 'NHL'
    }, {
        key: 'mma_mixed_martial_arts',
        label: 'UFC/MMA'
    }, {
        key: 'soccer_fc',
        label: 'FC'
    }, {
        key: 'soccer_wc',
        label: 'WC'
    }, {
        key: 'baseball_cws',
        label: 'CWS'
    }];
    var FREE_SPORTS = ['basketball_nba', 'icehockey_nhl', 'baseball_mlb', 'basketball_wnba', 'baseball_cws']; // free plan sports
    var MARKET_KEYS = {
        ML: 'h2h',
        Spread: 'spreads',
        Total: 'totals'
    };
    var COLORS = ['#4f6ef7', '#2dcc7e', '#f5c842', '#f05252', '#a78bfa', '#38bdf8', '#fb923c', '#e879f9', '#34d399', '#f87171', '#60a5fa', '#fbbf24', '#a3e635', '#c084fc', '#fb7185', '#22d3ee'];
    var currentSport = (function() {
        try {
            var saved = JSON.parse(localStorage.getItem('rax_sport_order') || 'null');
            if (Array.isArray(saved) && saved.length) return saved[0];
        } catch(e) {}
        return 'basketball_nba';
    })();
    var currentFcLeague = 'ALL';
    var rawRows = [];
    var rawRowsBySport = {}; // sport key -> parsed rows (same IDs as preds)
    var _alertSyncedIds = new Set(); // row IDs checked via alert sync (so we can uncheck on untake)
    var preds = {};
    var rsPredAdj = 0; // global RS% offset (+0/+1/+2) for sensitivity analysis
    var probsExact = {}; // full-precision RS probability per row id (from sync.js o.probability)
    var vols = {}; // volume display per row id
    var rsMarketIds   = {}; // row id -> RS market id (numeric, for payout API)
    var rsOutcomeKeys = {}; // row id -> RS outcome key (string e.g. "DET", for payout API)
    var payoutRatios = {}; // row id -> expectedPayout/amount (exact WS payout ratio, includes slippage)
    var yourLines = {};
    var altOdds = {}; // gameId -> { spreads: {teamName: {point: price}}, totals: {side: {point: price}} }
    var nbaPoller    = null;
    var wnbaPoller   = null;
    var mlbPoller    = null;
    var nhlPoller    = null;
    var dkPoller     = null;
    var fcPoller     = null;
    var wcPoller     = null;
    var scoresPoller = null;
    var wcSubTab     = 'games'; // 'games' | 'futures'
    var currentLoadAbort = null;
    var tabHiddenAt  = 0; // timestamp when tab was last hidden, for stale-check on return

    function stopAllPollers() {
        if (currentLoadAbort) { currentLoadAbort.abort(); currentLoadAbort = null; }
        if (nbaPoller)    { clearInterval(nbaPoller);    nbaPoller    = null; }
        if (wnbaPoller)   { clearInterval(wnbaPoller);   wnbaPoller   = null; }
        if (mlbPoller)    { clearInterval(mlbPoller);    mlbPoller    = null; }
        if (nhlPoller)    { clearInterval(nhlPoller);    nhlPoller    = null; }
        if (dkPoller)     { clearInterval(dkPoller);     dkPoller     = null; }
        if (fcPoller)     { clearInterval(fcPoller);     fcPoller     = null; }
        if (wcPoller)     { clearInterval(wcPoller);     wcPoller     = null; }
        if (scoresPoller) { clearInterval(scoresPoller); scoresPoller = null; }
        if (evAutoRefreshTimer) { clearInterval(evAutoRefreshTimer); evAutoRefreshTimer = null; }
    }

    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            tabHiddenAt = Date.now();
            // Pollers stay running but skip fetches while hidden (each poller checks document.hidden)
        } else {
            if (!currentUser) return;
            loadBetsTaken();
            var hiddenMs = tabHiddenAt ? Date.now() - tabHiddenAt : 0;
            tabHiddenAt = 0;
            // Only do a full reload if away for > 5 min — game list may have changed
            if (hiddenMs > 5 * 60 * 1000) {
                stopAllPollers();
                if (evTabVisible) loadAllEvSports();
                else loadOdds();
            }
            // Under 5 min: pollers resume at their next tick, table stays as-is
        }
    });
    var dkAltOdds = {}; // gid -> { spreads: { Away: {line: price}, Home: {line: price} }, totals: { Over: {line: price}, Under: {line: price} } }
    var dkPreGameStore = {}; // gid -> last known DK alt lines before/during game (persists when DK suspends in-game)
    var lastSyncData = {}; // sport -> last Real Sports sync response (d.markets object)
    var exclusiveBets = localStorage.getItem('raxedge_exclusive_bets') === '1';
    var betTaken = JSON.parse(localStorage.getItem('raxedge_bets_taken') || '{}');
    var autoTakenFrom = JSON.parse(localStorage.getItem('raxedge_auto_taken') || '{}'); // rowId → team name that was manually bet on the other side
    var wcFuturesCache = null;
    var portfolioConnected = false;
    var portHistoryAll    = [];   // accumulated all settled history items
    var portHistoryCursor = null; // last item id for next page
    var portHistoryMore   = false;
    var portSelectedDate  = localDateKey(new Date());
    var portTimeframe     = '1w';
    var PORT_CACHE_KEY    = 'rax_port_history_v1';

    // Returns "YYYY-MM-DD" in LOCAL timezone (not UTC)
    function localDateKey(dateOrIso) {
        var d = (dateOrIso instanceof Date) ? dateOrIso : new Date(dateOrIso);
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
    }

    function saveHistoryCache() {
        try {
            localStorage.setItem(PORT_CACHE_KEY, JSON.stringify({
                items: portHistoryAll,
                cursor: portHistoryCursor,
                hasMore: portHistoryMore,
                savedAt: Date.now()
            }));
        } catch(e) {}
    }

    function loadHistoryCache() {
        try {
            var raw = localStorage.getItem(PORT_CACHE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch(e) { return null; }
    }
    var portCalYear       = new Date().getFullYear();
    var portCalMonth      = new Date().getMonth(); // 0-based
    var portFilterSport   = '';
    var portFilterMarket  = '';
    var portFilterResult  = '';
    var portSortBy        = 'chrono-desc';
    var portShowAllTime   = false;
    var portSearchQuery   = '';
    var evTabCache        = {};   // sport key -> array of positive-EV row objects
    var evTabVisible      = false;
    var evHideTaken       = localStorage.getItem('raxedge_ev_hide_taken') === '1';
    var evMinEv           = parseFloat(localStorage.getItem('raxedge_ev_min_ev') || '5');
    var evLoadingInProgress = false; // true while loadAllEvSports Phase1/2 running — suppresses mid-load renders
    var evAutoRefreshTimer = null;
    var EV_REFRESH_MS = 5000; // refresh every 5 seconds (server caches absorb repeated hits)
    var rfiOdds = {}; // game key -> {yesFair, noFair, yesAm, noAm}
    var rsGameIds = {}; // game string -> Real Sports numeric gameId
    var rsGameSports = {}; // game string -> RS sport key (e.g. 'mls', 'epl') for URL generation
    var rsGameStartMs = {}; // game string -> game start epoch ms (from RS __startMs)

    function edgeBg(edge) {
        if (edge == null || edge <= 0) return '';
        var opacity = Math.min(edge / 10, 1) * 0.08;
        return 'background:rgba(45,204,126,' + opacity.toFixed(3) + ');';
    }

    var _hashids = null;
    var REAL_SPORT_IDS = { nba:1, nfl:2, ncaam:3, mlb:4, epl:5, ucl:6, nhl:7, mls:8, fifa:9, ufc:10, ncaaf:11, wnba:12, soccer:14, golf:15, fc:14 };
    var REAL_SPORT_LABELS = { 1:'NBA', 2:'NFL', 3:'NCAAB', 4:'MLB', 5:'EPL', 6:'UCL', 7:'NHL', 8:'MLS', 9:'FIFA', 10:'UFC', 11:'NCAAF', 12:'WNBA', 14:'Soccer', 15:'Golf' };
    var FC_LEAGUE_SPORT_ID = { 'EPL': 5, 'UCL': 6, 'MLS': 8, 'La Liga': 14, 'Serie A': 14, 'Bundesliga': 14, 'Ligue 1': 14 };
    // RS sport key → sport ID for URL hash encoding
    var RS_SPORT_KEY_ID = { 'epl': 5, 'ucl': 6, 'mls': 8, 'nba': 1, 'nfl': 2, 'mlb': 4, 'nhl': 7, 'ufc': 10, 'soccer': 14, 'cbb': 3, 'ncaabb': 16 };

    // ESPN CDN team logo URLs — keyed by DraftKings team name
    var TEAM_LOGO_URLS = {
        // NBA
        'Atlanta Hawks':'https://a.espncdn.com/i/teamlogos/nba/500/atl.png',
        'Boston Celtics':'https://a.espncdn.com/i/teamlogos/nba/500/bos.png',
        'Brooklyn Nets':'https://a.espncdn.com/i/teamlogos/nba/500/bkn.png',
        'Charlotte Hornets':'https://a.espncdn.com/i/teamlogos/nba/500/cha.png',
        'Chicago Bulls':'https://a.espncdn.com/i/teamlogos/nba/500/chi.png',
        'Cleveland Cavaliers':'https://a.espncdn.com/i/teamlogos/nba/500/cle.png',
        'Dallas Mavericks':'https://a.espncdn.com/i/teamlogos/nba/500/dal.png',
        'Denver Nuggets':'https://a.espncdn.com/i/teamlogos/nba/500/den.png',
        'Detroit Pistons':'https://a.espncdn.com/i/teamlogos/nba/500/det.png',
        'Golden State Warriors':'https://a.espncdn.com/i/teamlogos/nba/500/gs.png',
        'Houston Rockets':'https://a.espncdn.com/i/teamlogos/nba/500/hou.png',
        'Indiana Pacers':'https://a.espncdn.com/i/teamlogos/nba/500/ind.png',
        'LA Clippers':'https://a.espncdn.com/i/teamlogos/nba/500/lac.png',
        'Los Angeles Clippers':'https://a.espncdn.com/i/teamlogos/nba/500/lac.png',
        'Los Angeles Lakers':'https://a.espncdn.com/i/teamlogos/nba/500/lal.png',
        'LA Lakers':'https://a.espncdn.com/i/teamlogos/nba/500/lal.png',
        'Memphis Grizzlies':'https://a.espncdn.com/i/teamlogos/nba/500/mem.png',
        'Miami Heat':'https://a.espncdn.com/i/teamlogos/nba/500/mia.png',
        'Milwaukee Bucks':'https://a.espncdn.com/i/teamlogos/nba/500/mil.png',
        'Minnesota Timberwolves':'https://a.espncdn.com/i/teamlogos/nba/500/min.png',
        'New Orleans Pelicans':'https://a.espncdn.com/i/teamlogos/nba/500/no.png',
        'New York Knicks':'https://a.espncdn.com/i/teamlogos/nba/500/ny.png',
        'Oklahoma City Thunder':'https://a.espncdn.com/i/teamlogos/nba/500/okc.png',
        'Orlando Magic':'https://a.espncdn.com/i/teamlogos/nba/500/orl.png',
        'Philadelphia 76ers':'https://a.espncdn.com/i/teamlogos/nba/500/phi.png',
        'Phoenix Suns':'https://a.espncdn.com/i/teamlogos/nba/500/phx.png',
        'Portland Trail Blazers':'https://a.espncdn.com/i/teamlogos/nba/500/por.png',
        'Sacramento Kings':'https://a.espncdn.com/i/teamlogos/nba/500/sac.png',
        'San Antonio Spurs':'https://a.espncdn.com/i/teamlogos/nba/500/sa.png',
        'Toronto Raptors':'https://a.espncdn.com/i/teamlogos/nba/500/tor.png',
        'Utah Jazz':'https://a.espncdn.com/i/teamlogos/nba/500/utah.png',
        'Washington Wizards':'https://a.espncdn.com/i/teamlogos/nba/500/wsh.png',
        // WNBA
        'Atlanta Dream':'https://a.espncdn.com/i/teamlogos/wnba/500/atl.png',
        'Chicago Sky':'https://a.espncdn.com/i/teamlogos/wnba/500/chi.png',
        'Connecticut Sun':'https://a.espncdn.com/i/teamlogos/wnba/500/conn.png',
        'Dallas Wings':'https://a.espncdn.com/i/teamlogos/wnba/500/dal.png',
        'Indiana Fever':'https://a.espncdn.com/i/teamlogos/wnba/500/ind.png',
        'Las Vegas Aces':'https://a.espncdn.com/i/teamlogos/wnba/500/lv.png',
        'Los Angeles Sparks':'https://a.espncdn.com/i/teamlogos/wnba/500/la.png',
        'Minnesota Lynx':'https://a.espncdn.com/i/teamlogos/wnba/500/min.png',
        'New York Liberty':'https://a.espncdn.com/i/teamlogos/wnba/500/ny.png',
        'Phoenix Mercury':'https://a.espncdn.com/i/teamlogos/wnba/500/phx.png',
        'Seattle Storm':'https://a.espncdn.com/i/teamlogos/wnba/500/sea.png',
        'Washington Mystics':'https://a.espncdn.com/i/teamlogos/wnba/500/wsh.png',
        'Golden State Valkyries':'https://a.espncdn.com/i/teamlogos/wnba/500/gsv.png',
        'Toronto Tempo':'https://a.espncdn.com/i/teamlogos/wnba/500/tor.png',
        'Portland Fire':'https://a.espncdn.com/i/teamlogos/wnba/500/por.png',
        // NHL (DK uses abbreviated city names e.g. "BOS Bruins")
        'Anaheim Ducks':'https://a.espncdn.com/i/teamlogos/nhl/500/ana.png','ANA Ducks':'https://a.espncdn.com/i/teamlogos/nhl/500/ana.png',
        'Boston Bruins':'https://a.espncdn.com/i/teamlogos/nhl/500/bos.png','BOS Bruins':'https://a.espncdn.com/i/teamlogos/nhl/500/bos.png',
        'Buffalo Sabres':'https://a.espncdn.com/i/teamlogos/nhl/500/buf.png','BUF Sabres':'https://a.espncdn.com/i/teamlogos/nhl/500/buf.png',
        'Calgary Flames':'https://a.espncdn.com/i/teamlogos/nhl/500/cgy.png','CGY Flames':'https://a.espncdn.com/i/teamlogos/nhl/500/cgy.png',
        'Carolina Hurricanes':'https://a.espncdn.com/i/teamlogos/nhl/500/car.png','CAR Hurricanes':'https://a.espncdn.com/i/teamlogos/nhl/500/car.png',
        'Chicago Blackhawks':'https://a.espncdn.com/i/teamlogos/nhl/500/chi.png','CHI Blackhawks':'https://a.espncdn.com/i/teamlogos/nhl/500/chi.png',
        'Colorado Avalanche':'https://a.espncdn.com/i/teamlogos/nhl/500/col.png','COL Avalanche':'https://a.espncdn.com/i/teamlogos/nhl/500/col.png',
        'Columbus Blue Jackets':'https://a.espncdn.com/i/teamlogos/nhl/500/cbj.png','CBJ Blue Jackets':'https://a.espncdn.com/i/teamlogos/nhl/500/cbj.png',
        'Dallas Stars':'https://a.espncdn.com/i/teamlogos/nhl/500/dal.png','DAL Stars':'https://a.espncdn.com/i/teamlogos/nhl/500/dal.png',
        'Detroit Red Wings':'https://a.espncdn.com/i/teamlogos/nhl/500/det.png','DET Red Wings':'https://a.espncdn.com/i/teamlogos/nhl/500/det.png',
        'Edmonton Oilers':'https://a.espncdn.com/i/teamlogos/nhl/500/edm.png','EDM Oilers':'https://a.espncdn.com/i/teamlogos/nhl/500/edm.png',
        'Florida Panthers':'https://a.espncdn.com/i/teamlogos/nhl/500/fla.png','FLA Panthers':'https://a.espncdn.com/i/teamlogos/nhl/500/fla.png',
        'Los Angeles Kings':'https://a.espncdn.com/i/teamlogos/nhl/500/la.png','LA Kings':'https://a.espncdn.com/i/teamlogos/nhl/500/la.png',
        'Minnesota Wild':'https://a.espncdn.com/i/teamlogos/nhl/500/min.png','MIN Wild':'https://a.espncdn.com/i/teamlogos/nhl/500/min.png',
        'Montreal Canadiens':'https://a.espncdn.com/i/teamlogos/nhl/500/mtl.png','MTL Canadiens':'https://a.espncdn.com/i/teamlogos/nhl/500/mtl.png',
        'Nashville Predators':'https://a.espncdn.com/i/teamlogos/nhl/500/nsh.png','NSH Predators':'https://a.espncdn.com/i/teamlogos/nhl/500/nsh.png',
        'New Jersey Devils':'https://a.espncdn.com/i/teamlogos/nhl/500/nj.png','NJ Devils':'https://a.espncdn.com/i/teamlogos/nhl/500/nj.png',
        'New York Islanders':'https://a.espncdn.com/i/teamlogos/nhl/500/nyi.png','NY Islanders':'https://a.espncdn.com/i/teamlogos/nhl/500/nyi.png',
        'New York Rangers':'https://a.espncdn.com/i/teamlogos/nhl/500/nyr.png','NY Rangers':'https://a.espncdn.com/i/teamlogos/nhl/500/nyr.png',
        'Ottawa Senators':'https://a.espncdn.com/i/teamlogos/nhl/500/ott.png','OTT Senators':'https://a.espncdn.com/i/teamlogos/nhl/500/ott.png',
        'Philadelphia Flyers':'https://a.espncdn.com/i/teamlogos/nhl/500/phi.png','PHI Flyers':'https://a.espncdn.com/i/teamlogos/nhl/500/phi.png',
        'Pittsburgh Penguins':'https://a.espncdn.com/i/teamlogos/nhl/500/pit.png','PIT Penguins':'https://a.espncdn.com/i/teamlogos/nhl/500/pit.png',
        'San Jose Sharks':'https://a.espncdn.com/i/teamlogos/nhl/500/sj.png','SJ Sharks':'https://a.espncdn.com/i/teamlogos/nhl/500/sj.png',
        'Seattle Kraken':'https://a.espncdn.com/i/teamlogos/nhl/500/sea.png','SEA Kraken':'https://a.espncdn.com/i/teamlogos/nhl/500/sea.png',
        'St. Louis Blues':'https://a.espncdn.com/i/teamlogos/nhl/500/stl.png','STL Blues':'https://a.espncdn.com/i/teamlogos/nhl/500/stl.png',
        'Tampa Bay Lightning':'https://a.espncdn.com/i/teamlogos/nhl/500/tb.png','TB Lightning':'https://a.espncdn.com/i/teamlogos/nhl/500/tb.png',
        'Toronto Maple Leafs':'https://a.espncdn.com/i/teamlogos/nhl/500/tor.png','TOR Maple Leafs':'https://a.espncdn.com/i/teamlogos/nhl/500/tor.png',
        'Utah Mammoth':'https://a.espncdn.com/i/teamlogos/nhl/500/utah.png','UTA Mammoth':'https://a.espncdn.com/i/teamlogos/nhl/500/utah.png',
        'Vancouver Canucks':'https://a.espncdn.com/i/teamlogos/nhl/500/van.png','VAN Canucks':'https://a.espncdn.com/i/teamlogos/nhl/500/van.png',
        'Vegas Golden Knights':'https://a.espncdn.com/i/teamlogos/nhl/500/vgk.png','VGK Golden Knights':'https://a.espncdn.com/i/teamlogos/nhl/500/vgk.png',
        'Washington Capitals':'https://a.espncdn.com/i/teamlogos/nhl/500/wsh.png','WAS Capitals':'https://a.espncdn.com/i/teamlogos/nhl/500/wsh.png',
        'Winnipeg Jets':'https://a.espncdn.com/i/teamlogos/nhl/500/wpg.png','WPG Jets':'https://a.espncdn.com/i/teamlogos/nhl/500/wpg.png',
        // MLB
        'Arizona Diamondbacks':'https://a.espncdn.com/i/teamlogos/mlb/500/ari.png',
        'Atlanta Braves':'https://a.espncdn.com/i/teamlogos/mlb/500/atl.png',
        'Baltimore Orioles':'https://a.espncdn.com/i/teamlogos/mlb/500/bal.png',
        'Boston Red Sox':'https://a.espncdn.com/i/teamlogos/mlb/500/bos.png',
        'Chicago Cubs':'https://a.espncdn.com/i/teamlogos/mlb/500/chc.png',
        'Chicago White Sox':'https://a.espncdn.com/i/teamlogos/mlb/500/cws.png',
        'Cincinnati Reds':'https://a.espncdn.com/i/teamlogos/mlb/500/cin.png',
        'Cleveland Guardians':'https://a.espncdn.com/i/teamlogos/mlb/500/cle.png',
        'Colorado Rockies':'https://a.espncdn.com/i/teamlogos/mlb/500/col.png',
        'Detroit Tigers':'https://a.espncdn.com/i/teamlogos/mlb/500/det.png',
        'Houston Astros':'https://a.espncdn.com/i/teamlogos/mlb/500/hou.png',
        'Kansas City Royals':'https://a.espncdn.com/i/teamlogos/mlb/500/kc.png',
        'Los Angeles Angels':'https://a.espncdn.com/i/teamlogos/mlb/500/laa.png',
        'Los Angeles Dodgers':'https://a.espncdn.com/i/teamlogos/mlb/500/lad.png',
        'Miami Marlins':'https://a.espncdn.com/i/teamlogos/mlb/500/mia.png',
        'Milwaukee Brewers':'https://a.espncdn.com/i/teamlogos/mlb/500/mil.png',
        'Minnesota Twins':'https://a.espncdn.com/i/teamlogos/mlb/500/min.png',
        'New York Mets':'https://a.espncdn.com/i/teamlogos/mlb/500/nym.png',
        'New York Yankees':'https://a.espncdn.com/i/teamlogos/mlb/500/nyy.png',
        'Oakland Athletics':'https://a.espncdn.com/i/teamlogos/mlb/500/oak.png','Athletics':'https://a.espncdn.com/i/teamlogos/mlb/500/oak.png',
        'Philadelphia Phillies':'https://a.espncdn.com/i/teamlogos/mlb/500/phi.png',
        'Pittsburgh Pirates':'https://a.espncdn.com/i/teamlogos/mlb/500/pit.png',
        'San Diego Padres':'https://a.espncdn.com/i/teamlogos/mlb/500/sd.png',
        'San Francisco Giants':'https://a.espncdn.com/i/teamlogos/mlb/500/sf.png',
        'Seattle Mariners':'https://a.espncdn.com/i/teamlogos/mlb/500/sea.png',
        'St. Louis Cardinals':'https://a.espncdn.com/i/teamlogos/mlb/500/stl.png',
        'Tampa Bay Rays':'https://a.espncdn.com/i/teamlogos/mlb/500/tb.png',
        'Texas Rangers':'https://a.espncdn.com/i/teamlogos/mlb/500/tex.png',
        'Toronto Blue Jays':'https://a.espncdn.com/i/teamlogos/mlb/500/tor.png',
        'Washington Nationals':'https://a.espncdn.com/i/teamlogos/mlb/500/was.png',
        // College Baseball / CWS (ESPN NCAA numeric IDs)
        'North Carolina':'https://a.espncdn.com/i/teamlogos/ncaa/500/153.png',
        'West Virginia':'https://a.espncdn.com/i/teamlogos/ncaa/500/277.png',
        'Oklahoma':'https://a.espncdn.com/i/teamlogos/ncaa/500/201.png',
        'Georgia':'https://a.espncdn.com/i/teamlogos/ncaa/500/61.png',
        'LSU':'https://a.espncdn.com/i/teamlogos/ncaa/500/99.png',
        'Tennessee':'https://a.espncdn.com/i/teamlogos/ncaa/500/2633.png',
        'Arkansas':'https://a.espncdn.com/i/teamlogos/ncaa/500/8.png',
        'Florida':'https://a.espncdn.com/i/teamlogos/ncaa/500/57.png',
        'Texas':'https://a.espncdn.com/i/teamlogos/ncaa/500/251.png',
        'Texas A&M':'https://a.espncdn.com/i/teamlogos/ncaa/500/245.png',
        'Florida State':'https://a.espncdn.com/i/teamlogos/ncaa/500/52.png',
        'Mississippi State':'https://a.espncdn.com/i/teamlogos/ncaa/500/344.png',
        'Oregon State':'https://a.espncdn.com/i/teamlogos/ncaa/500/204.png',
        'Stanford':'https://a.espncdn.com/i/teamlogos/ncaa/500/24.png',
        'Virginia':'https://a.espncdn.com/i/teamlogos/ncaa/500/258.png',
        'Ole Miss':'https://a.espncdn.com/i/teamlogos/ncaa/500/145.png',
        'Miami':'https://a.espncdn.com/i/teamlogos/ncaa/500/2390.png',
        'Arizona':'https://a.espncdn.com/i/teamlogos/ncaa/500/12.png',
        'Arizona State':'https://a.espncdn.com/i/teamlogos/ncaa/500/9.png',
        'South Carolina':'https://a.espncdn.com/i/teamlogos/ncaa/500/2579.png',
        'Vanderbilt':'https://a.espncdn.com/i/teamlogos/ncaa/500/238.png',
        'TCU':'https://a.espncdn.com/i/teamlogos/ncaa/500/2628.png',
        'Louisville':'https://a.espncdn.com/i/teamlogos/ncaa/500/97.png',
        'NC State':'https://a.espncdn.com/i/teamlogos/ncaa/500/152.png',
        'Kentucky':'https://a.espncdn.com/i/teamlogos/ncaa/500/96.png',
        'Auburn':'https://a.espncdn.com/i/teamlogos/ncaa/500/2.png',
        'Alabama':'https://a.espncdn.com/i/teamlogos/ncaa/500/333.png',
        // Soccer (ESPN numeric IDs)
        'Arsenal':'https://a.espncdn.com/i/teamlogos/soccer/500/359.png',
        'Chelsea':'https://a.espncdn.com/i/teamlogos/soccer/500/363.png',
        'Liverpool':'https://a.espncdn.com/i/teamlogos/soccer/500/364.png',
        'Manchester City':'https://a.espncdn.com/i/teamlogos/soccer/500/382.png','Man City':'https://a.espncdn.com/i/teamlogos/soccer/500/382.png',
        'Manchester United':'https://a.espncdn.com/i/teamlogos/soccer/500/360.png','Man United':'https://a.espncdn.com/i/teamlogos/soccer/500/360.png','Man Utd':'https://a.espncdn.com/i/teamlogos/soccer/500/360.png',
        'Tottenham':'https://a.espncdn.com/i/teamlogos/soccer/500/367.png','Tottenham Hotspur':'https://a.espncdn.com/i/teamlogos/soccer/500/367.png',
        'Newcastle':'https://a.espncdn.com/i/teamlogos/soccer/500/361.png','Newcastle United':'https://a.espncdn.com/i/teamlogos/soccer/500/361.png',
        'Aston Villa':'https://a.espncdn.com/i/teamlogos/soccer/500/1213.png',
        'West Ham':'https://a.espncdn.com/i/teamlogos/soccer/500/371.png','West Ham United':'https://a.espncdn.com/i/teamlogos/soccer/500/371.png',
        'Brighton':'https://a.espncdn.com/i/teamlogos/soccer/500/331.png',
        'Fulham':'https://a.espncdn.com/i/teamlogos/soccer/500/370.png',
        'Wolves':'https://a.espncdn.com/i/teamlogos/soccer/500/380.png','Wolverhampton':'https://a.espncdn.com/i/teamlogos/soccer/500/380.png',
        'Everton':'https://a.espncdn.com/i/teamlogos/soccer/500/368.png',
        'Crystal Palace':'https://a.espncdn.com/i/teamlogos/soccer/500/384.png',
        'Bournemouth':'https://a.espncdn.com/i/teamlogos/soccer/500/349.png',
        'Brentford':'https://a.espncdn.com/i/teamlogos/soccer/500/337.png',
        'Nottm Forest':'https://a.espncdn.com/i/teamlogos/soccer/500/393.png','Nottingham Forest':'https://a.espncdn.com/i/teamlogos/soccer/500/393.png',
        'Leicester':'https://a.espncdn.com/i/teamlogos/soccer/500/375.png','Leicester City':'https://a.espncdn.com/i/teamlogos/soccer/500/375.png',
        'Barcelona':'https://a.espncdn.com/i/teamlogos/soccer/500/83.png',
        'Real Madrid':'https://a.espncdn.com/i/teamlogos/soccer/500/86.png',
        'Atletico Madrid':'https://a.espncdn.com/i/teamlogos/soccer/500/1068.png',
        'Sevilla':'https://a.espncdn.com/i/teamlogos/soccer/500/558.png',
        'Villarreal':'https://a.espncdn.com/i/teamlogos/soccer/500/102.png',
        'Athletic Club':'https://a.espncdn.com/i/teamlogos/soccer/500/77.png','Athletic Bilbao':'https://a.espncdn.com/i/teamlogos/soccer/500/77.png',
        'Real Sociedad':'https://a.espncdn.com/i/teamlogos/soccer/500/543.png',
        'Celta Vigo':'https://a.espncdn.com/i/teamlogos/soccer/500/558.png',
        'Juventus':'https://a.espncdn.com/i/teamlogos/soccer/500/111.png',
        'Inter':'https://a.espncdn.com/i/teamlogos/soccer/500/110.png','Inter Milan':'https://a.espncdn.com/i/teamlogos/soccer/500/110.png',
        'AC Milan':'https://a.espncdn.com/i/teamlogos/soccer/500/103.png','Milan':'https://a.espncdn.com/i/teamlogos/soccer/500/103.png',
        'Roma':'https://a.espncdn.com/i/teamlogos/soccer/500/104.png','AS Roma':'https://a.espncdn.com/i/teamlogos/soccer/500/104.png',
        'Napoli':'https://a.espncdn.com/i/teamlogos/soccer/500/113.png',
        'Lazio':'https://a.espncdn.com/i/teamlogos/soccer/500/112.png',
        'Fiorentina':'https://a.espncdn.com/i/teamlogos/soccer/500/107.png',
        'Atalanta':'https://a.espncdn.com/i/teamlogos/soccer/500/106.png',
        'Bayern Munich':'https://a.espncdn.com/i/teamlogos/soccer/500/132.png','FC Bayern Munich':'https://a.espncdn.com/i/teamlogos/soccer/500/132.png','Bayern':'https://a.espncdn.com/i/teamlogos/soccer/500/132.png',
        'Borussia Dortmund':'https://a.espncdn.com/i/teamlogos/soccer/500/124.png','Dortmund':'https://a.espncdn.com/i/teamlogos/soccer/500/124.png','BVB Dortmund':'https://a.espncdn.com/i/teamlogos/soccer/500/124.png',
        'Bayer Leverkusen':'https://a.espncdn.com/i/teamlogos/soccer/500/131.png','Leverkusen':'https://a.espncdn.com/i/teamlogos/soccer/500/131.png',
        'Paris St-Germain':'https://a.espncdn.com/i/teamlogos/soccer/500/160.png','PSG':'https://a.espncdn.com/i/teamlogos/soccer/500/160.png','Paris Saint-Germain':'https://a.espncdn.com/i/teamlogos/soccer/500/160.png',
        // UCL additional
        'Real Oviedo':'https://a.espncdn.com/i/teamlogos/soccer/500/3767.png',
        'Benfica':'https://a.espncdn.com/i/teamlogos/soccer/500/1929.png','SL Benfica':'https://a.espncdn.com/i/teamlogos/soccer/500/1929.png','S.L. Benfica':'https://a.espncdn.com/i/teamlogos/soccer/500/1929.png',
        'Sporting CP':'https://a.espncdn.com/i/teamlogos/soccer/500/2250.png','Sporting Lisbon':'https://a.espncdn.com/i/teamlogos/soccer/500/2250.png','Sporting Lisboa':'https://a.espncdn.com/i/teamlogos/soccer/500/2250.png','Sporting':'https://a.espncdn.com/i/teamlogos/soccer/500/2250.png',
        'Porto':'https://a.espncdn.com/i/teamlogos/soccer/500/437.png','FC Porto':'https://a.espncdn.com/i/teamlogos/soccer/500/437.png',
        'Celtic':'https://a.espncdn.com/i/teamlogos/soccer/500/249.png',
        'Ajax':'https://a.espncdn.com/i/teamlogos/soccer/500/169.png',
        'Club Brugge':'https://a.espncdn.com/i/teamlogos/soccer/500/245.png',
        'PSV Eindhoven':'https://a.espncdn.com/i/teamlogos/soccer/500/285.png','PSV':'https://a.espncdn.com/i/teamlogos/soccer/500/285.png',
        'FC Bayern':'https://a.espncdn.com/i/teamlogos/soccer/500/132.png','Bayern München':'https://a.espncdn.com/i/teamlogos/soccer/500/132.png','FC Bayern München':'https://a.espncdn.com/i/teamlogos/soccer/500/132.png','Bayern Munchen':'https://a.espncdn.com/i/teamlogos/soccer/500/132.png','FC Bayern Munchen':'https://a.espncdn.com/i/teamlogos/soccer/500/132.png',
    };

    // Country flag emoji for WC tab — no external CDN, renders natively on all platforms
    var WC_FLAG_EMOJI = {
        'Albania':'🇦🇱',
        'Algeria':'🇩🇿',
        'Argentina':'🇦🇷',
        'Australia':'🇦🇺',
        'Austria':'🇦🇹',
        'Belgium':'🇧🇪',
        'Bolivia':'🇧🇴',
        'Bosnia':'🇧🇦',
        'Bosnia and Herzegovina':'🇧🇦',
        'Brazil':'🇧🇷',
        'Burkina Faso':'🇧🇫',
        'Cameroon':'🇨🇲',
        'Canada':'🇨🇦',
        'Chile':'🇨🇱',
        'Colombia':'🇨🇴',
        'Comoros':'🇰🇲',
        'Costa Rica':'🇨🇷',
        'Croatia':'🇭🇷',
        'Cuba':'🇨🇺',
        'Czech Republic':'🇨🇿',
        'Denmark':'🇩🇰',
        'DR Congo':'🇨🇩',
        'Ecuador':'🇪🇨',
        'Egypt':'🇪🇬',
        'England':'🏴󠁧󠁢󠁥󠁮󠁧󠁿',
        'Finland':'🇫🇮',
        'France':'🇫🇷',
        'Germany':'🇩🇪',
        'Ghana':'🇬🇭',
        'Guatemala':'🇬🇹',
        'Haiti':'🇭🇹',
        'Honduras':'🇭🇳',
        'Hungary':'🇭🇺',
        'Iraq':'🇮🇶',
        'Iran':'🇮🇷',
        'Israel':'🇮🇱',
        'Ivory Coast':'🇨🇮',
        "Cote d'Ivoire":'🇨🇮',
        'Jamaica':'🇯🇲',
        'Japan':'🇯🇵',
        'Jordan':'🇯🇴',
        'Mali':'🇲🇱',
        'Mauritania':'🇲🇷',
        'Mexico':'🇲🇽',
        'Morocco':'🇲🇦',
        'Netherlands':'🇳🇱',
        'New Zealand':'🇳🇿',
        'Nigeria':'🇳🇬',
        'Norway':'🇳🇴',
        'Panama':'🇵🇦',
        'Paraguay':'🇵🇾',
        'Peru':'🇵🇪',
        'Poland':'🇵🇱',
        'Portugal':'🇵🇹',
        'Qatar':'🇶🇦',
        'Romania':'🇷🇴',
        'Saudi Arabia':'🇸🇦',
        'Scotland':'🏴󠁧󠁢󠁳󠁣󠁴󠁿',
        'Senegal':'🇸🇳',
        'Serbia':'🇷🇸',
        'Slovakia':'🇸🇰',
        'Slovenia':'🇸🇮',
        'South Africa':'🇿🇦',
        'South Korea':'🇰🇷',
        'Spain':'🇪🇸',
        'Cape Verde':'🇨🇻',
        'Curacao':'🇨🇼',
        'Curaçao':'🇨🇼',
        'Sweden':'🇸🇪',
        'Switzerland':'🇨🇭',
        'Tanzania':'🇹🇿',
        'Togo':'🇹🇬',
        'Trinidad and Tobago':'🇹🇹',
        'Tunisia':'🇹🇳',
        'Turkey':'🇹🇷',
        'Türkiye':'🇹🇷',
        'Ukraine':'🇺🇦',
        'Uruguay':'🇺🇾',
        'USA':'🇺🇸',
        'United States':'🇺🇸',
        'Uzbekistan':'🇺🇿',
        'Venezuela':'🇻🇪',
        'Wales':'🏴󠁧󠁢󠁷󠁬󠁳󠁿',
        'Zimbabwe':'🇿🇼',
    };

    // ISO 3166-1 alpha-2 codes for flagcdn.com flag images (WC futures tab)
    var WC_FLAG_CC = {
        'Albania':'al','Algeria':'dz','Argentina':'ar','Australia':'au','Austria':'at',
        'Belgium':'be','Bolivia':'bo','Bosnia':'ba','Bosnia and Herzegovina':'ba',
        'Brazil':'br','Burkina Faso':'bf','Cameroon':'cm','Canada':'ca','Chile':'cl',
        'Colombia':'co','Cape Verde':'cv','Costa Rica':'cr','Croatia':'hr','Cuba':'cu',
        'Curacao':'cw','Curaçao':'cw','Czech Republic':'cz','Denmark':'dk',
        'DR Congo':'cd','Ecuador':'ec','Egypt':'eg','England':'gb-eng','Finland':'fi',
        'France':'fr','Germany':'de','Ghana':'gh','Guatemala':'gt','Haiti':'ht',
        'Honduras':'hn','Hungary':'hu','Iraq':'iq','Iran':'ir','Ivory Coast':'ci',
        "Cote d'Ivoire":'ci','Jamaica':'jm','Japan':'jp','Jordan':'jo','Mali':'ml',
        'Mauritania':'mr','Mexico':'mx','Morocco':'ma','Netherlands':'nl',
        'New Zealand':'nz','Nigeria':'ng','Norway':'no','Panama':'pa','Paraguay':'py',
        'Peru':'pe','Poland':'pl','Portugal':'pt','Qatar':'qa','Romania':'ro',
        'Saudi Arabia':'sa','Scotland':'gb-sct','Senegal':'sn','Serbia':'rs',
        'Slovakia':'sk','Slovenia':'si','South Africa':'za','South Korea':'kr',
        'Spain':'es','Sweden':'se','Switzerland':'ch','Tanzania':'tz','Tunisia':'tn',
        'Turkey':'tr','Türkiye':'tr','Ukraine':'ua','Uruguay':'uy','USA':'us',
        'United States':'us','Uzbekistan':'uz','Venezuela':'ve','Wales':'gb-wls',
        'Zimbabwe':'zw',
    };

    // Actual brand hex colors — keyed by DraftKings team name
    var TEAM_COLORS = {
        // NBA
        'Atlanta Hawks':'#e03a3e','Boston Celtics':'#007a33','Brooklyn Nets':'#000000',
        'Charlotte Hornets':'#00788c','Chicago Bulls':'#ce1141','Cleveland Cavaliers':'#860038',
        'Dallas Mavericks':'#0053bc','Denver Nuggets':'#4fa8d5','Detroit Pistons':'#c8102e',
        'Golden State Warriors':'#1d428a','Houston Rockets':'#ce1141','Indiana Pacers':'#fdbb30',
        'LA Clippers':'#c8102e','Los Angeles Clippers':'#c8102e','Los Angeles Lakers':'#552583',
        'Memphis Grizzlies':'#5d76a9','Miami Heat':'#98002e','Milwaukee Bucks':'#00471b',
        'Minnesota Timberwolves':'#0c2340','New Orleans Pelicans':'#b4975a',
        'New York Knicks':'#f58426','Oklahoma City Thunder':'#007ac1','Orlando Magic':'#0077c0',
        'Philadelphia 76ers':'#006bb6','Phoenix Suns':'#e56020','Portland Trail Blazers':'#e03a3e',
        'Sacramento Kings':'#5a2d81','San Antonio Spurs':'#8a8d8f','Toronto Raptors':'#ce1141',
        'Utah Jazz':'#002b5c','Washington Wizards':'#002b5c',
        // NHL
        'Anaheim Ducks':'#f47a38','Arizona Coyotes':'#8c2633','Boston Bruins':'#fcb514',
        'Buffalo Sabres':'#003087','Calgary Flames':'#c8102e','Carolina Hurricanes':'#cc0000',
        'Chicago Blackhawks':'#cf0a2c','Colorado Avalanche':'#6f263d','Columbus Blue Jackets':'#002654',
        'Dallas Stars':'#006847','Detroit Red Wings':'#ce1126','Edmonton Oilers':'#ff4c00',
        'Florida Panthers':'#c8102e','Los Angeles Kings':'#111111','Minnesota Wild':'#154734',
        'Montreal Canadiens':'#af1e2d','Nashville Predators':'#ffb81c','New Jersey Devils':'#ce1126',
        'New York Islanders':'#00539b','New York Rangers':'#0038a8','Ottawa Senators':'#c52032',
        'Philadelphia Flyers':'#f74902','Pittsburgh Penguins':'#fcb514','San Jose Sharks':'#006d75',
        'Seattle Kraken':'#355464','St. Louis Blues':'#002f87','Tampa Bay Lightning':'#002868',
        'Toronto Maple Leafs':'#00205b','Vancouver Canucks':'#00843d','Vegas Golden Knights':'#b4975a',
        'Washington Capitals':'#041e42','Winnipeg Jets':'#041e42',
        // MLB
        'Arizona Diamondbacks':'#a71930','Atlanta Braves':'#ce1141','Baltimore Orioles':'#df4601',
        'Boston Red Sox':'#bd3039','Chicago Cubs':'#0e3386','Chicago White Sox':'#27251f',
        'Cincinnati Reds':'#c6011f','Cleveland Guardians':'#e31937','Colorado Rockies':'#33006f',
        'Detroit Tigers':'#0c2340','Houston Astros':'#002d62','Kansas City Royals':'#004687',
        'Los Angeles Angels':'#ba0021','Los Angeles Dodgers':'#005a9c','Miami Marlins':'#00a3e0',
        'Milwaukee Brewers':'#ffc52f','Minnesota Twins':'#002b5c','New York Mets':'#002d72',
        'New York Yankees':'#132448','Athletics':'#003831','Oakland Athletics':'#003831',
        'Philadelphia Phillies':'#e81828','Pittsburgh Pirates':'#27251f','San Diego Padres':'#2f241d',
        'San Francisco Giants':'#fd5a1e','Seattle Mariners':'#0c2c56','St. Louis Cardinals':'#c41e3a',
        'Tampa Bay Rays':'#092c5c','Texas Rangers':'#003278','Toronto Blue Jays':'#134a8e',
        'Washington Nationals':'#ab0003',
        // College Baseball / CWS
        'North Carolina':'#7BAFD4','West Virginia':'#002855','Oklahoma':'#841617',
        'Georgia':'#BA0C2F','LSU':'#461D7C','Tennessee':'#FF8200','Arkansas':'#9D2235',
        'Florida':'#0021A5','Texas':'#BF5700','Texas A&M':'#500000','Florida State':'#782F40',
        'Mississippi State':'#5D1725','Oregon State':'#D3492A','Stanford':'#8C1515',
        'Virginia':'#232D4B','Ole Miss':'#14213D','Miami':'#005030','Arizona':'#003366',
        'Arizona State':'#8C1D40','South Carolina':'#73000A','Vanderbilt':'#866D4B',
        'TCU':'#4D1979','Louisville':'#AD0000','NC State':'#CC0000','Kentucky':'#0033A0',
        'Auburn':'#0C2340','Alabama':'#9E1B32',
        // EPL
        'Arsenal':'#ef0107','Chelsea':'#034694','Liverpool':'#c8102e','Manchester City':'#6cabdd',
        'Manchester United':'#da291c','Man City':'#6cabdd','Man United':'#da291c',
        'Tottenham':'#132257','Tottenham Hotspur':'#132257',
        'Newcastle':'#241f20','Newcastle United':'#241f20',
        'Aston Villa':'#670e36','West Ham':'#7a263a','West Ham United':'#7a263a',
        'Brighton':'#0057b8','Everton':'#003399','Leicester':'#003090','Leicester City':'#003090',
        'Wolves':'#fdb913','Wolverhampton':'#fdb913',
        'Crystal Palace':'#1b458f','Brentford':'#e30613','Nottm Forest':'#dd0000',
        'Nottingham Forest':'#dd0000','Fulham':'#cc0000','Bournemouth':'#da291c',
        'Ipswich':'#0044a9','Ipswich Town':'#0044a9','Southampton':'#d71920',
        // La Liga
        'Barcelona':'#a50044','Real Madrid':'#00529f','Atletico Madrid':'#c00b2c',
        'Atlético Madrid':'#c00b2c','Athletic Club':'#ee2523','Athletic Bilbao':'#ee2523',
        'Sevilla':'#d4021d','Valencia':'#ed1c24','Villarreal':'#ffcc00',
        'Real Betis':'#00954c','Real Sociedad':'#0067b1','Osasuna':'#be0000',
        'Celta Vigo':'#5cbfeb','Getafe':'#005998','Girona':'#9b1c31',
        'Las Palmas':'#ffcb00','Leganes':'#003594','Leganés':'#003594',
        'Mallorca':'#e0001b','Rayo Vallecano':'#cc0000','Valladolid':'#8c3c98',
        'Espanyol':'#0057a8','Deportivo Alavés':'#005eb8','Alaves':'#005eb8',
        // Serie A
        'AC Milan':'#fb090b','Juventus':'#000000','Inter Milan':'#0068a8','Inter':'#0068a8',
        'Napoli':'#0067b1','Roma':'#8e1f2f','Lazio':'#87d8f7','Atalanta':'#1c3e81',
        'Fiorentina':'#6a1472','Torino':'#87200f','Bologna':'#ed0000',
        'Empoli':'#0082ca','Hellas Verona':'#004b98','Cagliari':'#b00000','Genoa':'#d40032',
        'Lecce':'#fac81e','Monza':'#ef3124','Parma':'#007bc2','Venezia':'#002856',
        'Como':'#003399','Udinese':'#000000',
        // Bundesliga
        'Bayern Munich':'#dc052d','FC Bayern Munich':'#dc052d','Bayern':'#dc052d',
        'Borussia Dortmund':'#fde100','Dortmund':'#fde100','BVB Dortmund':'#fde100',
        'Bayer Leverkusen':'#e32221','Leverkusen':'#e32221',
        'RB Leipzig':'#dd0741','Leipzig':'#dd0741',
        'Union Berlin':'#e2261c','Freiburg':'#e30613','Hoffenheim':'#1961a5',
        'Mainz':'#c3152a','Augsburg':'#bb1612','Wolfsburg':'#009843',
        'Stuttgart':'#e32219','Frankfurt':'#e1000f','Eintracht Frankfurt':'#e1000f',
        'Werder Bremen':'#1d9053','Heidenheim':'#d73b2d','Bochum':'#0558a1',
        // Ligue 1
        'Paris St-Germain':'#004170','PSG':'#004170','Paris Saint-Germain':'#004170',
        'Marseille':'#009bc4','Olympique Marseille':'#009bc4',
        'Lyon':'#1d2c6b','Olympique Lyon':'#1d2c6b',
        'Monaco':'#d4021d','Lille':'#e12219','Rennes':'#8b0304',
        'Nice':'#000000','Lens':'#e2b029','Strasbourg':'#2561ae',
        'Montpellier':'#eb5c00','Brest':'#063a6a','Toulouse':'#501e82',
        // UCL extras
        'Porto':'#003da5','Ajax':'#d2122e','Benfica':'#c8102e',
        'Sporting CP':'#00a650','PSV Eindhoven':'#e7241e','PSV':'#e7241e',
        'Celtic':'#16a34a','Rangers':'#0044a9','Feyenoord':'#b4141c',
        'Club Brugge':'#1a3667','Brugge':'#1a3667','Real Oviedo':'#003da5',
        // MLS
        'LA Galaxy':'#003087','LAFC':'#c39e6d','LA FC':'#c39e6d',
        'Seattle Sounders':'#5d9732','Portland Timbers':'#004812',
        'Atlanta United':'#80000a','New York City FC':'#6cace4','NYCFC':'#6cace4',
        'New York Red Bulls':'#ed1e36','D.C. United':'#231f20','DC United':'#231f20',
        'Philadelphia Union':'#004c97','Columbus Crew':'#ffd200','Chicago Fire':'#c00b1d',
        'Toronto FC':'#b81137','CF Montreal':'#003da5','Nashville SC':'#ecbf2f',
        'Orlando City':'#633492','FC Cincinnati':'#f05123','Inter Miami CF':'#f7b5cd',
        'Colorado Rapids':'#960a2c','Real Salt Lake':'#b30838','Vancouver Whitecaps':'#00245d',
        'Minnesota United':'#8b1c32','FC Dallas':'#e81f3e','Sporting KC':'#002b5c',
        'Sporting Kansas City':'#002b5c','Houston Dynamo':'#f4911e',
        'San Jose Earthquakes':'#003087','New England Revolution':'#ce0e2d',
        'Charlotte FC':'#1a85c8','St. Louis City':'#d42929','Austin FC':'#00b140',
        // WNBA
        'Atlanta Dream':'#c8102e','Chicago Sky':'#418fde','Connecticut Sun':'#e56020',
        'Dallas Wings':'#002b5c','Indiana Fever':'#e03a3e','Las Vegas Aces':'#c8102e',
        'Los Angeles Sparks':'#552583','Minnesota Lynx':'#0c2340','New York Liberty':'#00471b',
        'Phoenix Mercury':'#cb6015','Seattle Storm':'#2c5234','Washington Mystics':'#e31837',
        'Golden State Valkyries':'#1d428a','Toronto Tempo':'#7b3f8c','Portland Fire':'#cc0000',
    };

    // Secondary brand color — only for teams with two visually distinct colors.
    // Used to build two-color gradients in headers and row spans.
    var TEAM_COLORS_2 = {
        // MLB
        'Arizona Diamondbacks':'#000000',
        'Baltimore Orioles':   '#000000',
        'Boston Red Sox':      '#0C2340',
        'Chicago Cubs':        '#CC3433',
        'Cleveland Guardians': '#00385D',
        'Detroit Tigers':      '#FA4616',
        'Houston Astros':      '#EB6E1F',
        'Kansas City Royals':  '#BD9B60',
        'Los Angeles Angels':  '#003263',
        'Milwaukee Brewers':   '#12284B',
        'Minnesota Twins':     '#D31145',
        'New York Mets':       '#FF5910',
        'Oakland Athletics':   '#EFB21E',
        'Athletics':           '#EFB21E',
        'Philadelphia Phillies':'#284898',
        'Pittsburgh Pirates':  '#FDB827',
        'San Diego Padres':    '#FFC425',
        'San Francisco Giants':'#27251F',
        'Seattle Mariners':    '#005C5C',
        'St. Louis Cardinals': '#0C2340',
        'Tampa Bay Rays':      '#8FBCE6',
        'Texas Rangers':       '#C0111F',
        'Toronto Blue Jays':   '#E8291C',
        'Washington Nationals':'#14225A',
    };

    function teamColorHue(name) {
        var hash = 0;
        for (var ci = 0; ci < (name||'').length; ci++) hash = (name.charCodeAt(ci) + ((hash << 5) - hash)) | 0;
        return Math.abs(hash) % 360;
    }

    // Returns brand color hex or fallback hsl
    function teamColor(name) {
        return TEAM_COLORS[name] || (WC_FLAG_COLORS[name] && WC_FLAG_COLORS[name].c1) || ('hsl(' + teamColorHue(name) + ',65%,50%)');
    }

    // Returns brand color at given hex opacity suffix (e.g. '33' = 20%, '66' = 40%)
    // Works for both hex TEAM_COLORS and hsl fallback
    function teamColorAt(name, hexOp) {
        var c = TEAM_COLORS[name] || (WC_FLAG_COLORS[name] && WC_FLAG_COLORS[name].c1);
        if (c && c[0] === '#') return c + hexOp;
        return 'hsla(' + teamColorHue(name) + ',65%,50%,' + (parseInt(hexOp, 16) / 255).toFixed(2) + ')';
    }

    // Primary + secondary flag colors for WC nations — drives the gradient behind team name
    var WC_FLAG_COLORS = {
        'Albania':              { c1:'#E41E20', c2:'#000000' },
        'Algeria':              { c1:'#006233', c2:'#EF3340' },
        'Argentina':            { c1:'#74ACDF', c2:'#FFFFFF' },
        'Australia':            { c1:'#00008B', c2:'#FF0000' },
        'Austria':              { c1:'#ED2939', c2:'#FFFFFF' },
        'Belgium':              { c1:'#000000', c2:'#FAE042' },
        'Bolivia':              { c1:'#D52B1E', c2:'#F4E400' },
        'Bosnia':               { c1:'#003DA5', c2:'#FCDD09' },
        'Bosnia and Herzegovina': { c1:'#003DA5', c2:'#FCDD09' },
        'Brazil':               { c1:'#009C3B', c2:'#FFDF00' },
        'Burkina Faso':         { c1:'#EF2B2D', c2:'#009A00' },
        'Cameroon':             { c1:'#007A3D', c2:'#CE1126' },
        'Canada':               { c1:'#FF0000', c2:'#FFFFFF' },
        'Chile':                { c1:'#D52B1E', c2:'#003DA5' },
        'Colombia':             { c1:'#FCD116', c2:'#003087' },
        'Comoros':              { c1:'#3A75C4', c2:'#3D9A00' },
        'Costa Rica':           { c1:'#002B7F', c2:'#CE1126' },
        'Croatia':              { c1:'#FF0000', c2:'#003087' },
        'Cuba':                 { c1:'#002A8F', c2:'#CF142B' },
        'Czech Republic':       { c1:'#D7141A', c2:'#11457E' },
        'Denmark':              { c1:'#C60C30', c2:'#FFFFFF' },
        'DR Congo':             { c1:'#007FFF', c2:'#F7D618' },
        'Ecuador':              { c1:'#FFD100', c2:'#003580' },
        'Egypt':                { c1:'#CE1126', c2:'#000000' },
        'England':              { c1:'#CF091F', c2:'#FFFFFF' },
        'Finland':              { c1:'#003580', c2:'#FFFFFF' },
        'France':               { c1:'#002395', c2:'#ED2939' },
        'Germany':              { c1:'#DD0000', c2:'#FFCE00' },
        'Ghana':                { c1:'#006B3F', c2:'#FCD116' },
        'Guatemala':            { c1:'#4997D0', c2:'#FFFFFF' },
        'Haiti':                { c1:'#00209F', c2:'#D21034' },
        'Honduras':             { c1:'#0073CF', c2:'#FFFFFF' },
        'Hungary':              { c1:'#CE2939', c2:'#477050' },
        'Iraq':                 { c1:'#CE1126', c2:'#000000' },
        'Iran':                 { c1:'#239F40', c2:'#DA0000' },
        'Israel':               { c1:'#0038B8', c2:'#FFFFFF' },
        'Ivory Coast':          { c1:'#F77F00', c2:'#009A44' },
        "Cote d'Ivoire":        { c1:'#F77F00', c2:'#009A44' },
        'Jamaica':              { c1:'#000000', c2:'#FED100' },
        'Japan':                { c1:'#BC002D', c2:'#FFFFFF' },
        'Jordan':               { c1:'#007A3D', c2:'#CE1126' },
        'Mali':                 { c1:'#14B53A', c2:'#CE1126' },
        'Mauritania':           { c1:'#006233', c2:'#FFD700' },
        'Mexico':               { c1:'#006847', c2:'#CE1126' },
        'Morocco':              { c1:'#C1272D', c2:'#006233' },
        'Netherlands':          { c1:'#AE1C28', c2:'#21468B' },
        'New Zealand':          { c1:'#00247D', c2:'#CC142B' },
        'Nigeria':              { c1:'#008751', c2:'#FFFFFF' },
        'Norway':               { c1:'#EF2B2D', c2:'#002868' },
        'Panama':               { c1:'#DA121A', c2:'#1C4CA0' },
        'Paraguay':             { c1:'#D52B1E', c2:'#0038A8' },
        'Peru':                 { c1:'#D91023', c2:'#FFFFFF' },
        'Poland':               { c1:'#DC143C', c2:'#FFFFFF' },
        'Portugal':             { c1:'#FF0000', c2:'#006600' },
        'Qatar':                { c1:'#8D1B3D', c2:'#FFFFFF' },
        'Romania':              { c1:'#002B7F', c2:'#FCD116' },
        'Saudi Arabia':         { c1:'#006C35', c2:'#FFFFFF' },
        'Scotland':             { c1:'#003087', c2:'#FFFFFF' },
        'Senegal':              { c1:'#00853F', c2:'#E31B23' },
        'Serbia':               { c1:'#C6363C', c2:'#003DA5' },
        'Slovakia':             { c1:'#0B4EA2', c2:'#EE1C25' },
        'Slovenia':             { c1:'#003DA5', c2:'#EE1C25' },
        'South Africa':         { c1:'#007A4D', c2:'#DE3831' },
        'South Korea':          { c1:'#CD2E3A', c2:'#003478' },
        'Spain':                { c1:'#C60B1E', c2:'#FFC400' },
        'Cape Verde':           { c1:'#003893', c2:'#CF2027' },
        'Curacao':              { c1:'#002B7F', c2:'#F9E814' },
        'Curaçao':              { c1:'#002B7F', c2:'#F9E814' },
        'Sweden':               { c1:'#006AA7', c2:'#FECC02' },
        'Switzerland':          { c1:'#FF0000', c2:'#FFFFFF' },
        'Tanzania':             { c1:'#1EB53A', c2:'#00A3DD' },
        'Togo':                 { c1:'#D21034', c2:'#006A4E' },
        'Trinidad and Tobago':  { c1:'#CE1126', c2:'#000000' },
        'Tunisia':              { c1:'#E70013', c2:'#FFFFFF' },
        'Turkey':               { c1:'#E30A17', c2:'#FFFFFF' },
        'Türkiye':              { c1:'#E30A17', c2:'#FFFFFF' },
        'Ukraine':              { c1:'#005BBB', c2:'#FFD500' },
        'Uruguay':              { c1:'#5BA4CF', c2:'#FFFFFF' },
        'USA':                  { c1:'#3C3B6E', c2:'#B22234' },
        'United States':        { c1:'#3C3B6E', c2:'#B22234' },
        'Uzbekistan':           { c1:'#009FCA', c2:'#1EB53A' },
        'Venezuela':            { c1:'#CF142B', c2:'#00247D' },
        'Wales':                { c1:'#CF091F', c2:'#00B140' },
        'Zimbabwe':             { c1:'#006400', c2:'#D21034' },
    };

    function hexRgba(hex, alpha) {
        var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    // Renders team name as stacked city/nickname with team-color gradient
    function teamNameHtml(name) {
        name = name || '';
        var lastSpace = name.lastIndexOf(' ');
        var city = lastSpace > 0 ? name.slice(0, lastSpace) : '';
        var nick = lastSpace > 0 ? name.slice(lastSpace + 1) : name;
        var grad;
        var wfc = WC_FLAG_COLORS[name];
        if (wfc) {
            grad = 'background:linear-gradient(90deg,' + hexRgba(wfc.c1, 0.4) + ',' + hexRgba(wfc.c2, 0.2) + ',transparent)';
        } else {
            var _gc1 = TEAM_COLORS[name], _gc2 = TEAM_COLORS_2[name];
            if (_gc1 && _gc2) {
                grad = 'background:linear-gradient(90deg,' + hexRgba(_gc1, 0.4) + ',' + hexRgba(_gc2, 0.2) + ',transparent)';
            } else {
                grad = 'background:linear-gradient(90deg,' + teamColorAt(name, '30') + ',transparent)';
            }
        }
        var ln = 'display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        if (city) {
            return '<span style="overflow:hidden;margin-left:2px;padding:2px 8px 2px 5px;' + grad + ';border-radius:3px">'
                + '<span style="' + ln + ';font-size:9px;color:var(--muted2);font-weight:600;letter-spacing:.07em;text-transform:uppercase;line-height:1.3">' + city + '</span>'
                + '<span style="' + ln + ';font-size:13px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;line-height:1.2;color:var(--text)">' + nick + '</span>'
                + '</span>';
        }
        return '<span style="overflow:hidden;margin-left:2px;padding:3px 8px 3px 5px;' + grad + ';border-radius:3px;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--text)">' + name + '</span>';
    }

    function teamLogoHtml(name, size) {
        var cleanName = name ? name.replace(/^[\u2191\u2193\u2192\u2190\u2B06\u2B07\u27A1\u2B05\s]+/, '').trim() : name;
        var s = size || 18;
        var emoji = cleanName && WC_FLAG_EMOJI[cleanName];
        if (emoji) {
            return '<span style="font-size:' + Math.round(s * 1.15) + 'px;line-height:1;flex-shrink:0;vertical-align:middle">' + emoji + '</span>';
        }
        var url = cleanName && TEAM_LOGO_URLS[cleanName];
        var hue = teamColorHue(name);
        var letter = (name || '?').charAt(0).toUpperCase();
        var fb = 'display:inline-flex;align-items:center;justify-content:center;width:' + s + 'px;height:' + s + 'px;border-radius:50%;background:hsl(' + hue + ',55%,32%);font-size:' + Math.round(s * 0.52) + 'px;font-weight:700;color:#fff;font-family:var(--sans);flex-shrink:0;vertical-align:middle';
        var im = 'width:' + s + 'px;height:' + s + 'px;border-radius:50%;object-fit:contain;background:transparent;flex-shrink:0;vertical-align:middle;padding:0';
        if (url) {
            return '<img src="' + url + '" style="' + im + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'inline-flex\'" alt=""><span style="' + fb + ';display:none">' + letter + '</span>';
        }
        return '<span style="' + fb + '">' + letter + '</span>';
    }

    var _sportLogoMap = {
        basketball_nba:        'https://a.espncdn.com/i/teamlogos/leagues/500/nba.png',
        basketball_wnba:       'https://a.espncdn.com/i/teamlogos/leagues/500/wnba.png',
        basketball_ncaab:      'https://a.espncdn.com/i/teamlogos/leagues/500/ncaa.png',
        icehockey_nhl:         'https://a.espncdn.com/i/teamlogos/leagues/500/nhl.png',
        baseball_mlb:          'https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png',
        mma_mixed_martial_arts:'https://a.espncdn.com/i/teamlogos/leagues/500/ufc.png'
    };
    var _fcLeagueLogoMap = {
        'UCL':        'https://a.espncdn.com/i/leaguelogos/soccer/500/2.png',
        'EPL':        'https://a.espncdn.com/i/leaguelogos/soccer/500/23.png',
        'La Liga':    'https://a.espncdn.com/i/leaguelogos/soccer/500/15.png',
        'Serie A':    'https://a.espncdn.com/i/leaguelogos/soccer/500/12.png',
        'Bundesliga': 'https://a.espncdn.com/i/leaguelogos/soccer/500/10.png',
        'Ligue 1':    'https://a.espncdn.com/i/leaguelogos/soccer/500/9.png',
        'MLS':        'https://a.espncdn.com/i/leaguelogos/soccer/500/19.png'
    };
    function sportLogoHtml(sport, league, size) {
        var s = size || 20;
        var url = sport === 'soccer_fc' ? (_fcLeagueLogoMap[league] || _fcLeagueLogoMap['UCL']) : _sportLogoMap[sport];
        if (!url) return '';
        return '<img src="' + url + '" style="width:' + s + 'px;height:' + s + 'px;object-fit:contain;flex-shrink:0;vertical-align:middle" onerror="this.style.display=\'none\'">';
    }

    function getRealSportsUrl(gid, sport, league, game) {
        if (!gid || typeof Hashids === 'undefined') return null;
        if (!_hashids) _hashids = new Hashids('routing', 11);
        var sportId;
        // Use stored RS sport key if available (most accurate)
        var storedRsSport = game && rsGameSports[game];
        if (storedRsSport && RS_SPORT_KEY_ID[storedRsSport] != null) {
            sportId = RS_SPORT_KEY_ID[storedRsSport];
        } else if (sport === 'soccer_fc' && league) {
            sportId = FC_LEAGUE_SPORT_ID[league] || 14;
        } else {
            var sportKey = sport === 'mma_mixed_martial_arts' ? 'ufc' : sport === 'baseball_cws' ? 'cws' : (sport || '').split('_').pop();
            sportId = sportKey === 'cws' ? 16 : (REAL_SPORT_IDS[sportKey] || 0);
        }
        var hash = _hashids.encode([4, sportId, 0, gid]);
        return 'https://www.realapp.com/' + hash;
    }
    function getRealSportsMarketUrl(marketId) {
        if (!marketId || typeof Hashids === 'undefined') return null;
        if (!_hashids) _hashids = new Hashids('routing', 11);
        var hash = _hashids.encode([36, 0, 0, marketId]);
        return hash ? 'https://www.realapp.com/' + hash : null;
    }
    // Build RS URL directly from portfolio item fields (gameId + sportId already numeric)
    function getPortfolioGameUrl(p) {
        if (!p || p.gameId == null) return null;
        if (typeof Hashids === 'undefined') return null;
        if (!_hashids) _hashids = new Hashids('routing', 11);
        var sid = p.sportId || 0;
        var hash = _hashids.encode([4, sid, 0, p.gameId]);
        return hash ? 'https://www.realapp.com/' + hash : null;
    }
    var RAX_ICON = '<svg viewBox="0 0 512 512" style="width:13px;height:13px;vertical-align:-2px;display:inline-block;margin-right:1px" aria-hidden="true"><g fill="currentColor"><path d="M128.1,141.1h356.8C442.8,57.4,356.1,0,256,0C192,0,133.5,23.5,88.6,62.3L128.1,141.1z"/><polygon points="355.3,193.2 154.2,193.2 254.7,394"/><path d="M413.6,193.2L253.9,512c0.7,0,1.4,0,2.1,0c141.4,0,256-114.6,256-256c0-21.7-2.7-42.7-7.8-62.8H413.6z"/><path d="M225.6,452.1L50.7,103C18.9,145.7,0,198.6,0,256c0,121.7,85,223.6,198.8,249.6L225.6,452.1z"/></g></svg> ';
    var RS_LOGO_SVG = '<svg viewBox="0 0 800 800" fill="currentColor" aria-hidden="true" style="width:13px;height:13px;display:block"><path d="M183.33,106.42L143.1,36.68c-0.33-0.56-0.93-0.91-1.58-0.91L1.83,35.72c-1.4,0-2.28,1.52-1.58,2.74l418.39,725.21c0.7,1.22,2.46,1.22,3.16,0l69.82-121.01c0.33-0.56,0.33-1.26,0-1.82L257.35,234.72c-0.7-1.22,0.18-2.74,1.58-2.74l322.91,0.11c1.4,0,2.28,1.52,1.58,2.74l-49.72,86.04c-0.7,1.22,0.17,2.74,1.58,2.74l139.69,0.05c0.65,0,1.25-0.35,1.58-0.91l122.77-212.46c0.7-1.22-0.17-2.74-1.58-2.74l-612.82-0.22C184.26,107.34,183.66,106.99,183.33,106.42z"/></svg>';

    // Restore saved unit size and sync both inputs
    (function() {
        var saved = localStorage.getItem('raxedge_unit_size');
        if (saved && !isNaN(parseFloat(saved))) {
            var el = document.getElementById('unit-size');
            if (el) el.value = saved;
            var el2 = document.getElementById('ev-unit-size');
            if (el2) el2.value = saved;
        }
    })();

    // Dashboard mode: 'simple' (default for new users) or 'advanced'
    var dashMode = localStorage.getItem('raxedge_dash_mode') || 'simple';
    (function() {
        applyDashMode(dashMode);
    })();

    function applyDashMode(mode) {
        var tbl = document.getElementById('main-table');
        if (tbl) tbl.classList.toggle('dash-simple', mode === 'simple');
        var mc = document.getElementById('mobile-cards');
        if (mc) mc.classList.toggle('dash-simple', mode === 'simple');
        document.querySelectorAll('.dash-tog-btn').forEach(function(btn) {
            btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
        });
    }

    function setDashMode(mode) {
        dashMode = mode;
        localStorage.setItem('raxedge_dash_mode', mode);
        applyDashMode(mode);
        // Re-update EV elements so bet size appears/disappears immediately on mode switch
        document.querySelectorAll('.mc-side-ev[data-id]').forEach(function(el) {
            if (el.dataset.id) updateSideEdge(el.dataset.id);
        });
    }

    function toggleEvPopover(event) {
        event.stopPropagation();
        var pop = document.getElementById('ev-popover');
        if (!pop) return;
        pop.style.display = pop.style.display === 'block' ? 'none' : 'block';
    }

    document.addEventListener('click', function() {
        var pop = document.getElementById('ev-popover');
        if (pop) pop.style.display = 'none';
    });

    // Called when main dashboard unit size changes — sync to EV tab
    var _origUnitOninput = (function() {
        var el = document.getElementById('unit-size');
        return el ? el.getAttribute('oninput') : null;
    })();
    (function() {
        var el = document.getElementById('unit-size');
        if (!el) return;
        el.addEventListener('input', function() {
            var v = this.value;
            var el2 = document.getElementById('ev-unit-size');
            if (el2) el2.value = v;
            renderEvTab();
        });
    })();

    function toggleEvHideTaken() {
        evHideTaken = !evHideTaken;
        localStorage.setItem('raxedge_ev_hide_taken', evHideTaken ? '1' : '0');
        var btn = document.getElementById('ev-hide-taken-btn');
        if (btn) {
            btn.style.background = evHideTaken ? 'var(--accent)' : 'var(--bg3)';
            btn.style.color = evHideTaken ? '#fff' : 'var(--muted)';
            btn.style.borderColor = evHideTaken ? 'var(--accent)' : 'var(--border2)';
        }
        renderEvTab();
    }

    function initEvHideTaken() {
        var btn = document.getElementById('ev-hide-taken-btn');
        if (!btn) return;
        if (evHideTaken) {
            btn.style.background = 'var(--accent)';
            btn.style.color = '#fff';
            btn.style.borderColor = 'var(--accent)';
        }
    }

    function onEvUnitChange(val) {
        localStorage.setItem('raxedge_unit_size', val);
        var el = document.getElementById('unit-size');
        if (el) { el.value = val; renderTable(); }
        renderEvTab();
    }

    function onEvMinEvChange(val) {
        evMinEv = parseFloat(val) || 0;
        localStorage.setItem('raxedge_ev_min_ev', String(evMinEv));
        renderEvTab();
    }

    function toggleBet(id) {
        betTaken[id] = !betTaken[id];
        if (!betTaken[id]) delete betTaken[id];
        localStorage.setItem('raxedge_bets_taken', JSON.stringify(betTaken));
        try { posthog.capture(betTaken[id] ? 'bet_checked' : 'bet_unchecked', { sport: currentSport }); } catch(e) {}
        var _autoId = null;
        if (betTaken[id]) {
            if (exclusiveBets) _autoId = applyExclusiveBet(id);
        } else {
            // Un-taking — clean up auto-taken state
            if (autoTakenFrom.hasOwnProperty(id)) {
                // This was an auto-taken row — just clear its metadata
                delete autoTakenFrom[id];
            } else {
                // Manually-taken row un-checked — also clear the auto-taken opposite (regardless of exclusiveBets setting)
                var opp = id.endsWith('-A') ? id.slice(0,-2)+'-B' : id.endsWith('-B') ? id.slice(0,-2)+'-A' : null;
                if (opp && autoTakenFrom.hasOwnProperty(opp)) {
                    delete betTaken[opp];
                    delete autoTakenFrom[opp];
                    localStorage.setItem('raxedge_bets_taken', JSON.stringify(betTaken));
                    fetch('/api/bets/taken', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: opp, taken: false }) }).catch(function() {});
                    document.querySelectorAll('input[type="checkbox"][data-id="' + opp + '"]').forEach(function(cb) { cb.checked = false; });
                    var oppTr = document.querySelector('tr[data-row-id="' + opp + '"]');
                    if (oppTr) { oppTr.style.opacity = ''; oppTr.style.borderLeft = ''; }
                    document.querySelectorAll('.mc-bet-check[data-id="' + opp + '"]').forEach(function(el) {
                        var sideRow = el.closest('div[style*="display:flex"]');
                        if (sideRow) sideRow.style.opacity = '';
                    });
                }
            }
            localStorage.setItem('raxedge_auto_taken', JSON.stringify(autoTakenFrom));
        }
        // Sync to server so state persists across devices (single request to avoid race condition)
        var _syncBody = { id: id, taken: !!betTaken[id] };
        if (_autoId) _syncBody.also = _autoId;
        fetch('/api/bets/taken', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_syncBody)
        }).catch(function() {});
        document.querySelectorAll('input[type="checkbox"][data-id="' + id + '"]').forEach(function(cb) {
            cb.checked = !!betTaken[id];
        });
        var tr = document.querySelector('tr[data-row-id="' + id + '"]');
        if (tr) { tr.style.opacity = betTaken[id] ? '0.4' : ''; if (!betTaken[id]) tr.style.borderLeft = ''; }
        document.querySelectorAll('.mc-bet-check[data-id="' + id + '"]').forEach(function(el) {
            var sideRow = el.closest('div[style*="display:flex"]');
            if (sideRow) sideRow.style.opacity = betTaken[id] ? '0.4' : '';
        });
        if (evTabVisible && !evLoadingInProgress) renderEvTab();
        else renderTable();
    }

    var collapsed = {};
    var showEVOnly = false;

    async function loadBetsTaken() {
        try {
            var res = await fetch('/api/bets/taken', { credentials: 'same-origin' });
            if (!res.ok) return;
            var data = await res.json();
            var changed = false;
            (data.bet_ids || []).forEach(function(rawId) {
                var isAuto = rawId.startsWith('auto||');
                var id = isAuto ? rawId.slice(6) : rawId;
                if (!betTaken[id]) { betTaken[id] = true; changed = true; }
                if (isAuto && !autoTakenFrom[id]) { autoTakenFrom[id] = '__auto__'; changed = true; }
            });
            if (changed) {
                localStorage.setItem('raxedge_bets_taken', JSON.stringify(betTaken));
                localStorage.setItem('raxedge_auto_taken', JSON.stringify(autoTakenFrom));
                renderTable();
            }
        } catch(e) {}
    }

    function toggleEVOnly() {
        showEVOnly = !showEVOnly;
        var btn = document.getElementById('ev-only-btn');
        if (btn) {
            btn.style.background = showEVOnly ? 'var(--green)' : 'var(--bg3)';
            btn.style.color = showEVOnly ? '#fff' : 'var(--muted)';
            btn.style.borderColor = showEVOnly ? 'var(--green)' : 'var(--border2)';
        }
        try { posthog.capture('ev_filter_toggled', { enabled: showEVOnly, sport: currentSport }); } catch(e) {}
        renderTable();
    }

    function toggleRsAdj() {
        rsPredAdj = (rsPredAdj + 1) % 3;
        var active = rsPredAdj > 0;
        var label = 'RS +' + rsPredAdj + '%';
        var activeStyle = { bg: 'var(--accent)', color: '#fff', border: 'var(--accent)' };
        var inactiveStyle = { bg: 'var(--bg3)', color: 'var(--muted)', border: 'var(--border2)' };
        var s = active ? activeStyle : inactiveStyle;
        ['rs-adj-btn', 'ev-rs-adj-btn'].forEach(function(id) {
            var btn = document.getElementById(id);
            if (!btn) return;
            btn.textContent = label;
            btn.style.background = s.bg;
            btn.style.color = s.color;
            btn.style.borderColor = s.border;
        });
        renderTable();
        if (evTabVisible && !evLoadingInProgress) renderEvTab();
    }

    function toggleExclusiveBets() {
        exclusiveBets = !exclusiveBets;
        localStorage.setItem('raxedge_exclusive_bets', exclusiveBets ? '1' : '0');
        ['excl-bets-btn', 'ev-one-side-btn'].forEach(function(btnId) {
            var btn = document.getElementById(btnId);
            if (!btn) return;
            btn.style.background = exclusiveBets ? 'var(--accent)' : 'var(--bg3)';
            btn.style.color = exclusiveBets ? '#fff' : 'var(--muted)';
            btn.style.borderColor = exclusiveBets ? 'var(--accent)' : 'var(--border2)';
        });
    }

    function applyExclusiveBet(id) {
        var oppositeId = id.endsWith('-A') ? id.slice(0, -2) + '-B'
                       : id.endsWith('-B') ? id.slice(0, -2) + '-A'
                       : null;
        if (!oppositeId) return;
        if (betTaken[oppositeId]) return; // opposite already checked — nothing to do

        // Find the manually-taken row to record its team name for the "Took X" badge
        var manualTeam = '';
        var searchIn = [].concat(rawRows || []);
        for (var k in rawRowsBySport) { searchIn = searchIn.concat(rawRowsBySport[k] || []); }
        for (var k in evTabCache) { searchIn = searchIn.concat(evTabCache[k] || []); }
        var manualRow = searchIn.find(function(r) { return r.id === id; });
        if (manualRow) manualTeam = manualRow.side || '';

        betTaken[oppositeId] = true;
        autoTakenFrom[oppositeId] = manualTeam;
        localStorage.setItem('raxedge_bets_taken', JSON.stringify(betTaken));
        localStorage.setItem('raxedge_auto_taken', JSON.stringify(autoTakenFrom));
        document.querySelectorAll('input[type="checkbox"][data-id="' + oppositeId + '"]').forEach(function(cb) { cb.checked = true; });
        var tr = document.querySelector('tr[data-row-id="' + oppositeId + '"]');
        if (tr) tr.style.opacity = '0.4';
        document.querySelectorAll('.mc-bet-check[data-id="' + oppositeId + '"]').forEach(function(el) {
            var sideRow = el.closest('div[style*="display:flex"]');
            if (sideRow) sideRow.style.opacity = '0.4';
        });
        return 'auto||' + oppositeId; // caller (toggleBet) sends both IDs in one request
    }
    var mobileCollapsed = {};

    // Auth state
    var currentTab = 'login';

    function openGate(tab) {
        document.getElementById('landing').classList.remove('visible');
        document.getElementById('gate').style.display = 'flex';
        switchTab(tab || 'login');
        document.getElementById('gate-email').focus();
    }

    function closegate() {
        document.getElementById('gate').style.display = 'none';
        document.getElementById('landing').classList.add('visible');
    }

    function showForgotPassword() {
        var email = document.getElementById('gate-email').value.trim();
        document.getElementById('gate-fields').style.display = 'none';
        document.getElementById('gate-tabs').style.display = 'none';
        document.getElementById('gate-back-home').style.display = 'none';
        var fw = document.getElementById('gate-forgot');
        fw.style.display = 'flex';
        fw.style.flexDirection = 'column';
        fw.style.alignItems = 'center';
        document.getElementById('forgot-heading').style.display = '';
        document.getElementById('forgot-subtitle').style.display = '';
        document.getElementById('forgot-email').value = email;
        document.getElementById('forgot-email').style.display = '';
        document.getElementById('forgot-btn').style.display = '';
        document.getElementById('forgot-btn').textContent = 'Send Reset Link';
        document.getElementById('forgot-btn').disabled = false;
        document.getElementById('forgot-err').style.display = 'none';
        document.getElementById('forgot-ok').style.display = 'none';
        document.getElementById('forgot-email').focus();
    }

    function hideForgotPassword() {
        document.getElementById('gate-forgot').style.display = 'none';
        document.getElementById('gate-fields').style.display = '';
        document.getElementById('gate-tabs').style.display = '';
        document.getElementById('gate-back-home').style.display = '';
    }

    async function submitForgot() {
        var btn   = document.getElementById('forgot-btn');
        var email = document.getElementById('forgot-email').value.trim().toLowerCase();
        var errEl = document.getElementById('forgot-err');
        var okEl  = document.getElementById('forgot-ok');
        if (!email) { errEl.textContent = 'Please enter your email.'; errEl.style.display = 'block'; return; }
        btn.textContent = 'Sending...';
        btn.disabled = true;
        errEl.style.display = 'none';
        okEl.style.display = 'none';
        try {
            await fetch('/api/auth/forgot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
        } catch(e) {}
        document.getElementById('forgot-heading').style.display = 'none';
        document.getElementById('forgot-subtitle').style.display = 'none';
        document.getElementById('forgot-email').style.display = 'none';
        btn.style.display = 'none';
        okEl.style.display = 'block';
    }

    function switchTab(tab) {
        currentTab = tab;
        document.getElementById('tab-login').classList.toggle('active', tab === 'login');
        document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
        document.getElementById('gate-pass2').style.display = tab === 'signup' ? '' : 'none';
        document.getElementById('gate-btn').textContent = tab === 'login' ? 'Log In' : 'Create Account';
        var fl = document.getElementById('forgot-link');
        if (fl) fl.style.display = tab === 'login' ? '' : 'none';
        document.getElementById('gate-forgot').style.display = 'none';
        document.getElementById('gate-fields').style.display = '';
        document.getElementById('gate-back-home').style.display = '';
        document.getElementById('gate-err').style.display = 'none';
        document.getElementById('gate-ok').style.display = 'none';
        document.getElementById('gate-pass').setAttribute('autocomplete', tab === 'login' ? 'current-password' : 'new-password');
    }

    function showGateErr(msg) {
        var el = document.getElementById('gate-err');
        el.textContent = msg;
        el.style.display = 'block';
        document.getElementById('gate-ok').style.display = 'none';
    }
    function showGateOk(msg) {
        var el = document.getElementById('gate-ok');
        el.textContent = msg;
        el.style.display = 'block';
        document.getElementById('gate-err').style.display = 'none';
    }

    function handleUnauthenticated() {
        stopAllPollers();
        document.getElementById('dashboard').style.display = 'none';
        document.getElementById('landing').classList.add('visible');
    }

    function showToast(msg, type) {
        var el = document.getElementById('_toast');
        if (!el) {
            el = document.createElement('div');
            el.id = '_toast';
            el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#18181f;border:1px solid rgba(255,255,255,.15);color:#f0eff5;font-size:13px;padding:10px 20px;border-radius:8px;z-index:9999;max-width:480px;text-align:center;white-space:pre-line;box-shadow:0 4px 16px rgba(0,0,0,.4);transition:opacity .3s';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.borderColor = type === 'error' ? 'rgba(240,82,82,.4)' : 'rgba(255,255,255,.15)';
        el.style.display = 'block';
        el.style.opacity = '1';
        clearTimeout(el._t);
        el._t = setTimeout(function() {
            el.style.opacity = '0';
            setTimeout(function() { el.style.display = 'none'; }, 300);
        }, type === 'error' ? 6000 : 4000);
    }

    function showConfirm(msg, onYes) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
        var box = document.createElement('div');
        box.style.cssText = 'background:#18181f;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:24px;max-width:360px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.6)';
        var txt = document.createElement('p');
        txt.style.cssText = 'color:#f0eff5;font-size:14px;line-height:1.5;margin-bottom:20px';
        txt.textContent = msg;
        var btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:10px;justify-content:center';
        var cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        cancel.style.cssText = 'flex:1;padding:10px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#f0eff5;border-radius:6px;cursor:pointer;font-size:13px;min-height:44px';
        var confirm2 = document.createElement('button');
        confirm2.textContent = 'Confirm';
        confirm2.style.cssText = 'flex:1;padding:10px;border:none;background:#f05252;color:#fff;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;min-height:44px';
        function close() { document.body.removeChild(overlay); }
        cancel.onclick = close;
        confirm2.onclick = function() { close(); onYes(); };
        overlay.onclick = function(e) { if (e.target === overlay) close(); };
        btns.appendChild(cancel); btns.appendChild(confirm2);
        box.appendChild(txt); box.appendChild(btns);
        overlay.appendChild(box); document.body.appendChild(overlay);
    }

    async function submitAuth() {
        // Short delay so browser autofill (Safari/Chrome) commits values to the DOM
        // before we read them — without this, .value can be empty on first autofill tap
        await new Promise(function(r){ setTimeout(r, 80); });

        var email = document.getElementById('gate-email').value.trim();
        var pass = document.getElementById('gate-pass').value;
        var pass2 = document.getElementById('gate-pass2').value;
        var btn = document.getElementById('gate-btn');

        document.getElementById('gate-err').style.display = 'none';
        document.getElementById('gate-ok').style.display = 'none';

        if (!email || !pass) {
            showGateErr('Email and password required');
            return;
        }

        if (currentTab === 'signup') {
            if (pass.length < 8) {
                showGateErr('Password must be at least 8 characters');
                return;
            }
            if (pass !== pass2) {
                showGateErr('Passwords do not match');
                return;
            }
        }

        btn.disabled = true;
        btn.textContent = currentTab === 'login' ? 'Logging in...' : 'Creating account...';

        try {
            var endpoint = currentTab === 'login' ? '/api/auth/login' : '/api/auth/register';
            var regBody = { email, password: pass };
            if (currentTab === 'signup') {
                // reCAPTCHA v3 token
                try {
                    var rcToken = await grecaptcha.execute('6Let4qMsAAAAAFhvh6wy6Ai_Ruzq2j4MIlMhqRnl', { action: 'register' });
                    regBody.rcToken = rcToken;
                } catch(e) {}
            }
            var res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(regBody)
            });
            var data;
            try { data = await res.json(); } catch(e) { data = {}; }
            if (!res.ok) {
                showGateErr(data.error || ('Error ' + res.status + ' — please try again'));
            } else {
                try { posthog.identify(data.email, { email: data.email, plan: data.plan, is_admin: !!data.is_admin }); } catch(e) {}
                try { posthog.capture('login', { method: 'password', plan: data.plan }); } catch(e) {}
                // Brief pause — some browsers (Brave) need time to commit a cookie
                // from a fetch() response before it appears in the next request.
                await new Promise(function(r) { setTimeout(r, 300); });
                var meCheck = await fetch('/api/auth/me', { credentials: 'same-origin' });
                if (meCheck.ok) {
                    checkSession();
                } else if (data._t) {
                    window.location.href = '/api/auth/finalize?t=' + encodeURIComponent(data._t);
                } else {
                    checkSession();
                }
            }
        } catch (e) {
            showGateErr('Network error -- please try again');
        } finally {
            btn.disabled = false;
            btn.textContent = currentTab === 'login' ? 'Log In' : 'Create Account';
        }
    }

    async function logOut() {
        await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'same-origin'
        });
        location.reload();
    }

    async function checkSession(retries) {
        retries = retries || 0;
        try {
            var res = await fetch('/api/auth/me', {
                credentials: 'same-origin'
            });
            if (res.ok) {
                var data = await res.json();
                currentUser = data;
                try { posthog.identify(data.email, { email: data.email, plan: data.plan, is_admin: !!data.is_admin }); } catch(e) {}
                try { posthog.capture('session_restored', { plan: data.plan }); } catch(e) {}
                document.getElementById('gate').style.display = 'none';
                document.getElementById('landing').classList.remove('visible');
                document.getElementById('dashboard').style.display = 'block';
                showTrialNudge(data);
                buildTabs();
                if (isPro()) loadGroupCode();
                await loadBetsTaken();
                // If redirected back from bookmarklet, open portfolio tab
                if (sessionStorage.getItem('pending_rs_token')) {
                    var portBtn2 = document.getElementById('portfolio-tab-btn');
                    if (portBtn2) { setTimeout(function(){ portBtn2.click(); }, 100); }
                } else {
                    setTimeout(loadOdds, 50);
                    setTimeout(preloadAllSports, 3000); // background preload after current sport loads
                }
            } else if (res.status === 401 || res.status === 403) {
                document.getElementById('landing').classList.add('visible');
            } else if (retries < 3) {
                setTimeout(function() { checkSession(retries + 1); }, 2000);
            } else {
                document.getElementById('landing').classList.add('visible');
            }
        } catch (e) {
            // Network error during refresh (common on mobile) — retry before showing login
            if (retries < 3) {
                setTimeout(function() { checkSession(retries + 1); }, 2000);
            } else {
                document.getElementById('landing').classList.add('visible');
            }
        }
    }

    // Enter key support on gate inputs
    document.addEventListener('DOMContentLoaded', function() {
        ['gate-email', 'gate-pass', 'gate-pass2'].forEach(function(id) {
            document.getElementById(id).addEventListener('keydown', function(e) {
                if (e.key === 'Enter')
                    submitAuth();
            });
        });

        // Handle ?rs_token=...&rs_uuid=... redirect from bookmarklet
        var urlParams = new URLSearchParams(window.location.search);
        var rsToken = urlParams.get('rs_token');
        var rsUuid  = urlParams.get('rs_uuid');
        if (rsToken) {
            // Store in sessionStorage so we can send it after auth is confirmed
            sessionStorage.setItem('pending_rs_token', rsToken);
            sessionStorage.setItem('pending_rs_uuid', rsUuid || '');
            // Clean URL
            history.replaceState({}, '', '/');
        }

        // Set bookmarklet href — uses current origin so it works on staging and prod
        var dashOrigin = window.location.origin;
        var bmCode = '(function(){try{var raw=localStorage.getItem(\'e-accounts\');if(!raw){alert(\'Not logged in to Real Sports\');return;}var d=JSON.parse(raw);var ai=Array.isArray(d)?(d[0]&&d[0].authInfo)||null:d.authInfo||null;if(!ai||!ai.token){alert(\'Auth not found \u2014 try logging out and back in on Real Sports\');return;}var tok=ai.userId+\'!\'+ai.deviceId+\'!\'+ai.token;var uuid=localStorage.getItem(\'realdeviceuuid\')||\'\';window.location=\'' + dashOrigin + '/?rs_token=\'+encodeURIComponent(tok)+\'&rs_uuid=\'+encodeURIComponent(uuid);}catch(e){alert(\'Error: \'+e.message);}})();';
        var bmLink = document.getElementById('port-bookmarklet-link');
        if (bmLink) bmLink.href = 'javascript:' + bmCode;

        window._bmScript = 'javascript:' + bmCode;

        // Populate mobile script preview (truncated for display)
        var preview = document.getElementById('port-mobile-script-preview');
        var fullScript = 'javascript:' + bmCode;
        if (preview) preview.textContent = fullScript.slice(0, 60) + '…';
    });

    function copyBmScript() {
        var script = window._bmScript;
        if (!script) return;
        var btn = document.getElementById('port-copy-js-btn');
        navigator.clipboard.writeText(script).then(function() {
            if (btn) { btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = 'Copy Script'; }, 2000); }
        }).catch(function() {
            // Fallback for browsers without clipboard API
            var ta = document.createElement('textarea');
            ta.value = script;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            if (btn) { btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = 'Copy Script'; }, 2000); }
        });
    }

    function imp(n) {
        n = Number(n);
        if (!isFinite(n))
            return null;
        return n < 0 ? Math.abs(n) / (Math.abs(n) + 100) : 100 / (n + 100);
    }
    function novig(a, b) {
        if (a == null || b == null)
            return {
                fa: null,
                fb: null
            };
        var t = a + b;
        if (!isFinite(t) || t <= 0)
            return {
                fa: null,
                fb: null
            };
        return {
            fa: a / t,
            fb: b / t
        };
    }
    function novig3(a, b, c) {
        if (a == null || b == null || c == null) return { fa: null, fb: null, fc: null };
        var t = a + b + c;
        if (!isFinite(t) || t <= 0) return { fa: null, fb: null, fc: null };
        return { fa: a / t, fb: b / t, fc: c / t };
    }
    function mktLbl(m) {
        return m === 'h2h' ? 'ML' : m === 'spreads' ? 'Spread' : m === 'totals' ? 'Total' : m;
    }
    function fmtMkt(m) {
        return m === 'ML' ? 'Game Winner' : m;
    }
    function fmtAm(n) {
        n = Number(n);
        return !isFinite(n) ? '-' : n >= 0 ? '+' + n : '' + n;
    }
    function units(e) {
        if (e == null || !isFinite(e))
            return 0;
        if (e >= 12)
            return 3;
        if (e >= 8)
            return 2;
        if (e >= 5)
            return 1;
        if (e >= 3)
            return 0.5;
        return 0;
    }
    function unitsEV(ev, realPct) {
        if (ev == null || !isFinite(ev)) return 0;
        var maxU = (realPct != null && realPct < 0.075) ? 0.25
                 : (realPct != null && realPct < 0.15)  ? 0.5
                 : (realPct != null && realPct < 0.25)  ? 0.5  // underdogs: cap at 0.5u
                 : 3;
        if (ev >= 35) return Math.min(3, maxU);
        if (ev >= 20) return Math.min(2, maxU);
        if (ev >= 10) return Math.min(1, maxU);
        if (ev >= 5)  return Math.min(0.5, maxU);
        return 0;
    }
    function getAdjFair(r, yl) {
        var pairs = {};
        rawRows.forEach(function(x) {
            if (!pairs[x.pid]) pairs[x.pid] = {};
            pairs[x.pid][x.ps] = x;
        });
        var pair = pairs[r.pid] || {};
        var nv = novig(pair.A ? imp(pair.A.am) : null, pair.B ? imp(pair.B.am) : null);
        var altNV = getAltFair(r, yl, pair.A, pair.B);
        if (altNV) return r.ps === 'A' ? altNV.fa : altNV.fb;
        var fair = r.ps === 'A' ? nv.fa : nv.fb;
        return adjFair(fair, r.pt, yl, r.mkt, r.ps);
    }

    // Per-half-point adjustment rates by sport (fallback when no alternate line available)
    var LINE_ADJ_RATE = {
        'icehockey_nhl':             0.025,
        'baseball_mlb':              0.02,
        'basketball_nba':            0.005,
        'basketball_wnba':           0.005,
        'basketball_ncaab':          0.005,
        'soccer_fc':                 0.03,
        'soccer_wc':                 0.03,
        'mma_mixed_martial_arts':    0.005
    };

    // RS rake by RS probability — empirically measured via Socket.io payout data
    // Rake is probability-dependent (underdogs pay more), NOT volume-dependent
    // Volume only affects slippage (separate, small for typical bet sizes)
    function rsBaseTake(p) {
        var pts = [[0.0918,0.0535],[0.13,0.065],[0.1737,0.0464],[0.32,0.046],[0.3757,0.039],[0.49,0.020],[0.59,0.018],[0.73,0.015],[0.7816,0.0125]];
        if (p <= pts[0][0]) return pts[0][1];
        if (p >= pts[pts.length-1][0]) return pts[pts.length-1][1];
        for (var i = 0; i < pts.length - 1; i++) {
            if (p >= pts[i][0] && p < pts[i+1][0]) {
                var t = (p - pts[i][0]) / (pts[i+1][0] - pts[i][0]);
                return pts[i][1] + t * (pts[i+1][1] - pts[i][1]);
            }
        }
        return 0.034;
    }

    function adjFair(fair, fd, yl, mkt, ps, sport) {
        if (fair == null || mkt === 'ML')
            return fair;
        if (fd == null || yl == null || yl === '')
            return fair;
        var d = parseFloat(yl) - parseFloat(fd);
        if (!isFinite(d) || d === 0)
            return fair;
        d = Math.max(Math.min(d, 3.5), -3.5); // cap at 3.5 pts to prevent large line gap distortion
        var rate = LINE_ADJ_RATE[sport || currentSport] || 0.005;
        var adj = (d / 0.5) * rate;
        if (mkt === 'Total') {
            adj = ps === 'A' ? -adj : adj;
        }
        return Math.min(Math.max(fair + adj, 0.01), 0.99);
    }

    // Look up FanDuel alternate odds at Real Sports line.
    // Returns {fa, fb} novig from real alternate prices, or null if not available.
    function dkClosestPrice(lines, target) {
        if (!lines) return null;
        var exact = lines[target];
        if (exact != null) return exact;
        // Find nearest available line within 0.5 — beyond that lines are too different to use as fair value
        var keys = Object.keys(lines).map(Number);
        if (!keys.length) return null;
        var closest = null, bestDist = Infinity;
        keys.forEach(function(k) {
            var d = Math.abs(k - target);
            if (d < bestDist && d <= 0.5) { bestDist = d; closest = k; }
        });
        return closest != null ? lines[closest] : null;
    }

    function getAltFair(r, yl, pA, pB) {
        if (yl == null || yl === '' || r.mkt === 'ML') return null;
        if (!r.gid) return null;
        var realLine = parseFloat(yl);
        if (!isFinite(realLine)) return null;

        // Always check DK alt data when available — even when RS line = FD line.
        // DK is the sharper book; using FD when they diverge creates false positive EV.
        var dk = dkAltOdds[r.gid];
        if (!dk) {
            // No DK alt data — skip when lines match (no adjustment needed)
            if (realLine === parseFloat(r.pt)) return null;
            return null; // can't compute without DK
        }

        var priceA, priceB;
        if (r.mkt === 'Total') {
            priceA = dkClosestPrice(dk.totals && dk.totals['Over'],  realLine);
            priceB = dkClosestPrice(dk.totals && dk.totals['Under'], realLine);
        } else if (r.mkt === 'Spread') {
            if (!pA || !pB || !dk.spreads) return null;
            var ylA = yourLines[pA.id];
            var ylB = yourLines[pB.id];
            if (ylA == null || ylB == null) return null;
            priceA = dkClosestPrice(dk.spreads['Away'], parseFloat(ylA));
            priceB = dkClosestPrice(dk.spreads['Home'], parseFloat(ylB));
        }
        if (priceA == null || priceB == null) return null;
        return novig(imp(priceA), imp(priceB));
    }
    // Live scores — ESPN public scoreboard, polled every 30s while a sport tab is active
    var _scoresCache = {}; // sport → { games: [...] }

    var SCORES_SPORTS = new Set(['baseball_mlb','basketball_wnba','icehockey_nhl','soccer_wc','baseball_cws']);

    function normTeam(name) {
        return (name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    }

    function teamsMatch(a, b) {
        var na = normTeam(a), nb = normTeam(b);
        if (!na || !nb) return false;
        return na === nb || na.includes(nb) || nb.includes(na);
    }

    function findScoreForGame(gameKey, sport) {
        var cache = _scoresCache[sport];
        if (!cache || !cache.games) return null;
        var parts = gameKey.split(' @ ');
        var awayKey = (parts[0] || '').trim();
        var homeKey = (parts[1] || '').trim();
        for (var i = 0; i < cache.games.length; i++) {
            var g = cache.games[i];
            if (teamsMatch(g.awayTeam, awayKey) && teamsMatch(g.homeTeam, homeKey)) return g;
        }
        return null;
    }

    function updateScoreBadges() {
        var sport = currentSport;
        if (!SCORES_SPORTS.has(sport)) return;
        document.querySelectorAll('.gh-score-badge').forEach(function(el) {
            var gameKey = el.dataset.game;
            if (!gameKey) return;
            var g = findScoreForGame(gameKey, sport);
            if (!g || g.status === 'pre') { el.style.display = 'none'; return; }
            var scoreText = g.awayScore + ' - ' + g.homeScore;
            var labelText = g.label ? ' | ' + g.label : '';
            el.textContent = scoreText + labelText;
            el.style.display = '';
            el.className = 'gh-score-badge gh-badge' + (g.status === 'live' ? ' urgent' : '');
        });
        // Mobile cards score badges
        document.querySelectorAll('.mc-score-badge').forEach(function(el) {
            var gameKey = el.dataset.game;
            if (!gameKey) return;
            var g = findScoreForGame(gameKey, sport);
            if (!g || g.status === 'pre') { el.style.display = 'none'; return; }
            el.textContent = g.awayScore + ' - ' + g.homeScore + (g.label ? ' | ' + g.label : '');
            el.style.display = '';
            el.className = 'mc-score-badge gh-badge' + (g.status === 'live' ? ' urgent' : '');
        });
    }

    async function fetchAndApplyScores(sport) {
        if (!SCORES_SPORTS.has(sport)) return;
        try {
            var res = await fetch('/api/scores?sport=' + sport, { credentials: 'same-origin' });
            if (!res.ok) return;
            var data = await res.json();
            if (data.ok && data.games) {
                _scoresCache[sport] = data;
                if (currentSport === sport) updateScoreBadges();
            }
        } catch(e) {}
    }

    function startScoresPoller(sport) {
        if (scoresPoller) { clearInterval(scoresPoller); scoresPoller = null; }
        if (!SCORES_SPORTS.has(sport)) return;
        fetchAndApplyScores(sport);
        scoresPoller = setInterval(function() {
            if (currentSport !== sport) { clearInterval(scoresPoller); scoresPoller = null; return; }
            if (document.hidden) return;
            fetchAndApplyScores(sport);
        }, 30000);
    }

    function timeInfo(c) {
        if (!c)
            return {
                lbl: 'TBD',
                cls: ''
            };
        var m = (c - new Date()) / 60000;
        if (m < -120)
            return {
                lbl: 'LIVE',
                cls: 'urgent'
            };
        if (m < 0)
            return {
                lbl: Math.round(-m) + 'm ago',
                cls: 'urgent'
            };
        if (m < 120)
            return {
                lbl: Math.round(m) + 'm',
                cls: 'urgent'
            };
        if (m < 360)
            return {
                lbl: (Math.round(m / 6) / 10) + 'h',
                cls: 'soon'
            };
        var timeStr = c.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        var now2 = new Date();
        var isToday = now2.toDateString() === c.toDateString();
        if (isToday) {
            return { lbl: timeStr, cls: '' };
        }
        var tom = new Date(now2); tom.setDate(tom.getDate() + 1);
        var prefix = tom.toDateString() === c.toDateString()
            ? 'Tomorrow'
            : c.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return { lbl: prefix + ' ' + timeStr, cls: '' };
    }
    function getFair(r) {
        if (r._wcFair != null) return r._wcFair;
        if (r.mkt === 'RFI' && r.rfiFair != null) return r.rfiFair;
        var pairs = {};
        rawRows.forEach(function(x) {
            if (!pairs[x.pid])
                pairs[x.pid] = {};
            pairs[x.pid][x.ps] = x;
        });
        var p = pairs[r.pid] || {};
        var nv = novig(p.A ? imp(p.A.am) : null, p.B ? imp(p.B.am) : null);
        return r.ps === 'A' ? nv.fa : nv.fb;
    }

    function toggleAll() {
        var btn = document.getElementById('collapse-btn');
        var allCollapsed = Object.keys(collapsed).length > 0 && Object.values(collapsed).every(function(v) {
            return v;
        });
        var allMobileCollapsed = Object.keys(mobileCollapsed).length > 0 && Object.values(mobileCollapsed).every(function(v) {
            return v;
        });
        var isCollapsed = allCollapsed && allMobileCollapsed;

        if (isCollapsed) {
            Object.keys(collapsed).forEach(function(k) {
                collapsed[k] = false;
            });
            document.querySelectorAll('tr[data-gk]:not(.ghrow)').forEach(function(tr) {
                tr.classList.remove('collapsed-row');
            });
            document.querySelectorAll('.gh-arrow').forEach(function(el) {
                el.classList.add('up');
            });
            Object.keys(mobileCollapsed).forEach(function(k) {
                mobileCollapsed[k] = false;
            });
            document.querySelectorAll('.game-card-body').forEach(function(el) {
                el.classList.remove('collapsed');
            });
            document.querySelectorAll('.gc-arrow').forEach(function(el) {
                el.classList.add('up');
            });
            if (btn)
                btn.textContent = 'Collapse All';
            var mbtn = document.getElementById('mobile-collapse-btn');
            if (mbtn)
                mbtn.textContent = 'Collapse All';
        } else {
            var gOrder = [];
            document.querySelectorAll('tr.ghrow').forEach(function(tr) {
                var gk = tr.getAttribute('data-gk');
                if (gk && gOrder.indexOf(gk) === -1)
                    gOrder.push(gk);
            });
            gOrder.forEach(function(k) {
                collapsed[k] = true;
            });
            document.querySelectorAll('tr[data-gk]:not(.ghrow)').forEach(function(tr) {
                tr.classList.add('collapsed-row');
            });
            document.querySelectorAll('.gh-arrow').forEach(function(el) {
                el.classList.remove('up');
            });
            document.querySelectorAll('.game-card-body').forEach(function(el) {
                var game = el.getAttribute('data-game');
                if (game)
                    mobileCollapsed[game] = true;
                el.classList.add('collapsed');
            });
            document.querySelectorAll('.gc-arrow').forEach(function(el) {
                el.classList.remove('up');
            });
            if (btn)
                btn.textContent = 'Expand All';
            var mbtn = document.getElementById('mobile-collapse-btn');
            if (mbtn)
                mbtn.textContent = 'Expand All';
        }
    }

    function mk(tag, attrs, children) {
        var el = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function(k) {
            el.setAttribute(k, attrs[k]);
        });
        (children || []).forEach(function(c) {
            if (typeof c === 'string')
                el.insertAdjacentHTML('beforeend', c);
            else if (c)
                el.appendChild(c);
        });
        return el;
    }

    function renderMobileCards(filtered) {
        var container = document.getElementById('mobile-cards');
        if (!container)
            return;
        container.innerHTML = '';

        var unit = parseFloat(document.getElementById('unit-size').value) || 300;
        var gameOrder = [],
            gameSeen = {};
        filtered.forEach(function(r) {
            if (!gameSeen[r.game]) {
                gameSeen[r.game] = true;
                gameOrder.push(r.game);
            }
        });

        // Returns a readable team nickname, preserving multi-word mascots (Red Sox, Blue Jays, etc.)
        function mobNick(name) {
            var s = (name || '').replace(/^[↑↓→←⬆⬇➡⬅\s]+/, '').trim();
            var w = s.split(' ');
            if (w.length >= 2) {
                var last2 = w.slice(-2).join(' ').toLowerCase();
                var MULTI = {
                    'red sox': 'Red Sox', 'white sox': 'White Sox',
                    'blue jays': 'Blue Jays', 'trail blazers': 'Blazers',
                    'blue jackets': 'Blue Jackets', 'maple leafs': 'Maple Leafs',
                    'red wings': 'Red Wings', 'golden knights': 'G.Knights'
                };
                if (MULTI[last2]) return MULTI[last2];
            }
            return w[w.length - 1] || s;
        }

        var COLORS = ['#4f6ef7', '#2dcc7e', '#f5c842', '#f05252', '#a78bfa', '#38bdf8', '#fb923c', '#e879f9', '#34d399', '#f87171', '#60a5fa', '#fbbf24'];
        var leagueBadgeMap = {
            basketball_nba: 'NBA',
            basketball_ncaab: 'NCAAB',
            icehockey_nhl: 'NHL',
            baseball_mlb: 'MLB',
            mma_mixed_martial_arts: 'UFC',
            soccer_fc: 'FC',
            soccer_wc: 'WC',
            baseball_cws: 'CWS'
        };
        var leagueColorMap = {
            basketball_nba: '#4f6ef7',
            basketball_ncaab: '#f5c842',
            icehockey_nhl: '#38bdf8',
            baseball_mlb: '#2dcc7e',
            mma_mixed_martial_arts: '#f05252',
            soccer_fc: '#2dcc7e',
            soccer_wc: '#f5a623',
            baseball_cws: '#f5a623'
        };
        var leagueLbl = leagueBadgeMap[currentSport] || '';
        var leagueClr = leagueColorMap[currentSport] || 'var(--muted)';

        if (!gameOrder.length) {
            container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">No odds loaded</div>';
            return;
        }

        gameOrder.forEach(function(game, gi) {
            var gameRows = filtered.filter(function(r) {
                return r.game === game;
            });
            if (!gameRows.length)
                return;
            var _mgp = game.split(' @ ');
            var _mht = (_mgp[0] || game).trim(); // away team drives card color
            var color = teamColor(_mht);
            var isC = !!mobileCollapsed[game];
            var ti = timeInfo(gameRows[0].cm);
            var teams = game.split(' @ ');

            var card = document.createElement('div');
            card.className = 'game-card';
            card.style.borderTop = '2px solid ' + teamColorAt(_mht, '66');

            var hdr = document.createElement('div');
            hdr.className = 'game-card-header';
            hdr.dataset.game = game;
            hdr.style.borderLeft = '4px solid ' + color;
            var _homeTeamForGrad = (teams[1] || '').replace(/\s*\(Game \d+\)/, '').trim();
            hdr.style.background = 'linear-gradient(90deg, ' + teamColorAt(_mht, '22') + ' 0%, var(--bg3) 42%, ' + teamColorAt(_homeTeamForGrad, '22') + ' 100%)';
            hdr.addEventListener('click', function() {
                toggleMobileCard(this.dataset.game);
            });

            var _mobDhMatch = (teams[1] || '').match(/^(.*?)\s*(\(Game (\d+)\))\s*$/);
            var _mobHomeTeam = _mobDhMatch ? _mobDhMatch[1].trim() : (teams[1] || '');
            var _mobGameNum  = _mobDhMatch ? _mobDhMatch[3] : null;
            var _mobSportLbl = (SPORTS.find(function(s) { return s.key === currentSport; }) || {}).label || '';
            var _mobNickA = mobNick(teams[0]);
            var _mobNickH = mobNick(_mobHomeTeam);
            var _leagueLogoMap = {
                'basketball_nba': 'https://a.espncdn.com/i/teamlogos/leagues/500/nba.png',
                'icehockey_nhl': 'https://a.espncdn.com/i/teamlogos/leagues/500/nhl.png',
                'baseball_mlb': 'https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png',
                'basketball_wnba': 'https://a.espncdn.com/i/teamlogos/leagues/500/wnba.png'
            };
            var _leagueLogoUrl = _leagueLogoMap[currentSport] || '';
            var _leagueBadge = _leagueLogoUrl
                ? '<img src="' + escHtml(_leagueLogoUrl) + '" style="width:18px;height:18px;object-fit:contain;display:block" onerror="this.style.display=\'none\'">'
                : '<span style="font-size:8px;font-weight:700;color:var(--muted2);letter-spacing:.05em;text-transform:uppercase">' + escHtml(_mobSportLbl) + '</span>';
            function _mobTeamHtml(name, nick) {
                return '<div style="display:flex;align-items:center;gap:5px;flex:1;min-width:0;overflow:hidden">'
                    + teamLogoHtml(name, 20)
                    + '<div style="font-size:13px;font-weight:700;letter-spacing:.03em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">' + escHtml(nick) + '</div>'
                    + '</div>';
            }

            var title = document.createElement('span');
            title.className = 'gc-title';
            title.innerHTML = '<div style="display:flex;align-items:center;gap:4px;flex:1;min-width:0">'
                + _mobTeamHtml(teams[0], _mobNickA)
                + '<div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;gap:1px;margin:0 6px">'
                + _leagueBadge
                + '<span style="color:var(--muted2);font-size:8px;line-height:1">@</span>'
                + '</div>'
                + _mobTeamHtml(_mobHomeTeam, _mobNickH)
                + '</div>';
            hdr.appendChild(title);

            if (_mobGameNum) {
                var _gnBadge = document.createElement('span');
                _gnBadge.className = 'gh-badge';
                _gnBadge.style.cssText = 'flex-shrink:0;margin-right:4px;background:rgba(255,255,255,0.1);color:var(--muted2);font-size:10px;letter-spacing:.06em';
                _gnBadge.textContent = 'GAME ' + _mobGameNum;
                hdr.appendChild(_gnBadge);
            }

            var arrow = document.createElement('span');
            arrow.className = 'gc-arrow' + (isC ? '' : ' up');
            arrow.id = 'gc-arrow-' + gi;
            arrow.innerHTML = '&#9660;';
            hdr.appendChild(arrow);
            card.appendChild(hdr);

            // Store rsUrl and ti for ML section footer
            var _rsUrl = getRealSportsUrl(rsGameIds[game], currentSport, gameRows[0] && gameRows[0].league, game);
            var _ti = ti;

            var body = document.createElement('div');
            body.className = 'game-card-body' + (isC ? ' collapsed' : '');
            body.dataset.game = game;

            var mkts = (currentSport === 'baseball_mlb' || currentSport === 'baseball_cws') ? ['ML', 'RFI'] : ['ML', 'Spread', 'Total'];
            mkts.forEach(function(mkt) {
                var mktRows = gameRows.filter(function(r) {
                    return r.mkt === mkt;
                });
                var isLocked = !isPro() && mkt !== 'ML' && mkt !== 'RFI';
                if (!mktRows.length && !isLocked)
                    return;

                var section = document.createElement('div');
                section.className = 'mc-section';

                var lbl = document.createElement('div');
                lbl.className = 'mc-label';
                var lblTxt = document.createElement('span');
                lblTxt.textContent = fmtMkt(mkt);
                lbl.appendChild(lblTxt);
                var firstRow = mktRows[0];
                if (firstRow && vols[firstRow.id]) {
                    var volTag = document.createElement('span');
                    volTag.className = 'mc-vol';
                    volTag.style.cssText = 'font-size:9px;color:var(--muted2);font-family:var(--mono);font-weight:400;position:absolute;right:0;top:0';
                    volTag.textContent = vols[firstRow.id] + ' vol';
                    lbl.appendChild(volTag);
                }
                // Market-specific RS URL for this section; fall back to game URL
                var _mktRsUrl = (firstRow && rsMarketIds[firstRow.id])
                    ? getRealSportsMarketUrl(rsMarketIds[firstRow.id])
                    : null;
                if (!_mktRsUrl) _mktRsUrl = _rsUrl;

                // RS icon inline inside mc-label (next to market name)
                if (_mktRsUrl) {
                    var _rsInlineBtn = document.createElement('a');
                    _rsInlineBtn.href = _mktRsUrl;
                    _rsInlineBtn.target = '_blank';
                    _rsInlineBtn.className = 'rs-icon-btn';
                    _rsInlineBtn.title = 'View on Real Sports';
                    _rsInlineBtn.innerHTML = RS_LOGO_SVG;
                    _rsInlineBtn.style.cssText = 'margin-left:5px;vertical-align:middle';
                    _rsInlineBtn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        try { posthog.capture('bet_link_opened', { sport: currentSport, game: game, market: mkt }); } catch(_e) {}
                    });
                    lbl.appendChild(_rsInlineBtn);
                }

                // Time badge bar — ML section only
                if (mkt === 'ML' && _ti && _ti.lbl) {
                    var mlTopBar = document.createElement('div');
                    mlTopBar.style.cssText = 'display:flex;align-items:center;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border)';
                    var tbTime = document.createElement('span');
                    tbTime.className = 'gh-badge ' + (_ti.cls || '');
                    tbTime.style.cssText = 'font-size:11px;font-family:var(--mono)';
                    tbTime.textContent = _ti.lbl;
                    mlTopBar.appendChild(tbTime);
                    section.appendChild(mlTopBar);
                }

                section.appendChild(lbl);

                if (isLocked) {
                    var teams = game.split(' @ ');
                    var lockedWrap = document.createElement('div');
                    lockedWrap.className = 'mc-locked';
                    var blurContent = document.createElement('div');
                    blurContent.className = 'mc-locked-blur';
                    var fakeRows = mkt === 'Total'
                    ? [{side: 'Over', val: 'O 224.5'}, {side: 'Under', val: 'U 224.5'}]
                    : [{side: teams[0] || 'Home', val: '-3.5'}, {side: teams[1] || 'Away', val: '+3.5'}];
                    fakeRows.forEach(function(f) {
                        var fakeRow = document.createElement('div');
                        fakeRow.className = 'mc-row';
                        fakeRow.style.cssText = 'margin-bottom:6px';
                        fakeRow.innerHTML = '<span class="mc-side">' + f.side + '</span>'
                        + '<span class="mc-odds" style="filter:blur(5px)">' + f.val + '</span>'
                        + '<span class="mc-fair" style="filter:blur(5px)">-110</span>';
                        blurContent.appendChild(fakeRow);
                    });
                    var fakeInp = document.createElement('div');
                    fakeInp.style.cssText = 'display:flex;gap:8px;padding-top:8px;border-top:1px solid var(--border);filter:blur(4px)';
                    fakeInp.innerHTML = '<div style="flex:1;height:32px;background:var(--bg3);border-radius:5px;border:1px solid var(--border2)"></div>'
                    + '<div style="flex:1;height:32px;background:var(--bg3);border-radius:5px;border:1px solid var(--border2)"></div>';
                    blurContent.appendChild(fakeInp);
                    lockedWrap.appendChild(blurContent);
                    var overlay = document.createElement('div');
                    overlay.className = 'mc-locked-overlay';
                    overlay.onclick = function() {
                        showUpgradeModal(mkt + ' markets are available on the Pro plan. Upgrade to unlock Spread and Total betting across all sports.');
                    };
                    overlay.innerHTML = '<span class="mc-locked-badge">PRO</span><span class="mc-locked-msg">Tap to unlock ' + mkt + '</span>';
                    lockedWrap.appendChild(overlay);
                    section.appendChild(lockedWrap);
                    body.appendChild(section);
                    return;
                }

                mktRows.forEach(function(r) {
                    var row = document.createElement('div');
                    row.className = 'mc-row mc-adv';

                    var side = document.createElement('span');
                    side.className = 'mc-side';
                    side.textContent = r.side;
                    row.appendChild(side);

                    // For NBA/NHL spread/total, use DK alt price when available (matches desktop rendering)
                    var dispAmMc = r.am;
                    if ((currentSport === 'basketball_nba' || currentSport === 'icehockey_nhl') && r.gid && dkAltOdds[r.gid] && (r.mkt === 'Spread' || r.mkt === 'Total')) {
                        var dkMc = dkAltOdds[r.gid];
                        var dkMcSideKey = r.mkt === 'Spread' ? (r.ps === 'A' ? 'Away' : 'Home') : (r.ps === 'A' ? 'Over' : 'Under');
                        var ylMc = yourLines[r.id] != null ? yourLines[r.id] : r.pt;
                        if (ylMc != null) {
                            var dkMcLines = r.mkt === 'Spread' ? (dkMc.spreads && dkMc.spreads[dkMcSideKey]) : (dkMc.totals && dkMc.totals[dkMcSideKey]);
                            var dkMcPrice = dkClosestPrice(dkMcLines, parseFloat(ylMc));
                            if (dkMcPrice != null) dispAmMc = dkMcPrice;
                        }
                    }

                    var odds = document.createElement('span');
                    odds.className = 'mc-odds mc-adv ' + (Number(dispAmMc) >= 0 ? 'odds-pos' : 'odds-neg');
                    odds.textContent = fmtAm(dispAmMc);
                    row.appendChild(odds);

                    var fair = document.createElement('span');
                    fair.className = 'mc-fair mc-adv';
                    fair.textContent = r.af != null ? (r.af * 100).toFixed(1) + '%' : '-';
                    row.appendChild(fair);

                    section.appendChild(row);
                });

                var inputRow = document.createElement('div');
                inputRow.className = 'mc-inputs';
                inputRow.style.cssText = 'flex-direction:column;gap:6px;display:flex';

                if (mkt === 'ML') {
                    var mlInputs = [];
                    mktRows.forEach(function(r) {
                        var pval = preds[r.id] || '';
                        var teamNick = mobNick(r.side);
                        // Wrapper so opacity applies to row + ev together
                        var teamWrap = document.createElement('div');
                        teamWrap.className = 'mc-team-wrap';
                        teamWrap.style.cssText = 'margin-bottom:5px;padding-left:6px;border-left:3px solid transparent;border-radius:1px' + (betTaken[r.id] ? ';opacity:0.4' : '');
                        // Top row: logo + nickname | input | checkbox
                        var sideRow = document.createElement('div');
                        sideRow.style.cssText = 'display:flex;align-items:center;gap:5px';
                        var teamInfo = document.createElement('div');
                        teamInfo.style.cssText = 'display:flex;align-items:center;gap:4px;flex:1;min-width:0';
                        teamInfo.innerHTML = teamLogoHtml(r.side, 16);
                        var nameLbl = document.createElement('span');
                        nameLbl.style.cssText = 'font-size:10px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0';
                        nameLbl.textContent = teamNick;
                        teamInfo.appendChild(nameLbl);
                        sideRow.appendChild(teamInfo);
                        var inp = document.createElement('input');
                        inp.className = 'mc-inp' + (pval ? ' filled' : '');
                        inp.type = 'number'; inp.min = '1'; inp.max = '99'; inp.step = '0.5';
                        inp.placeholder = '%'; inp.value = pval; inp.dataset.id = r.id;
                        inp.style.cssText = 'width:44px;flex-shrink:0';
                        inp.addEventListener('input', function() {
                            var v = parseFloat(this.value);
                            if (!isNaN(v) && v >= 1 && v <= 99 && mlInputs.length === 2) {
                                mlInputs.forEach(function(other) {
                                    if (other !== inp) {
                                        var otherVal = (100 - v).toFixed(1);
                                        other.value = otherVal;
                                        preds[other.dataset.id] = otherVal;
                                        other.classList.add('filled');
                                        setPredMobile(other);
                                    }
                                });
                            }
                            setPredMobile(this);
                        });
                        inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') this.blur(); });
                        sideRow.appendChild(inp);
                        mlInputs.push(inp);
                        var mlCb = document.createElement('input');
                        mlCb.type = 'checkbox'; mlCb.className = 'mc-bet-check'; mlCb.dataset.id = r.id;
                        mlCb.checked = !!betTaken[r.id]; mlCb.title = 'Mark bet taken';
                        mlCb.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:' + (autoTakenFrom[r.id] ? '#f5a623' : 'var(--green)') + ';flex-shrink:0';
                        mlCb.addEventListener('change', function() { toggleBet(this.dataset.id); });
                        sideRow.appendChild(mlCb);
                        teamWrap.appendChild(sideRow);
                        // EV below the row so team name has full width
                        var evRow = document.createElement('div');
                        evRow.style.cssText = 'text-align:right;padding-right:21px;margin-top:1px';
                        var se = document.createElement('span');
                        se.className = 'mc-side-edge mc-adv';
                        se.dataset.id = r.id;
                        se.style.cssText = 'font-family:var(--mono);font-size:10px;font-weight:600;color:var(--muted2)';
                        var sev = document.createElement('span');
                        sev.className = 'mc-side-ev';
                        sev.dataset.id = r.id;
                        sev.style.cssText = 'font-family:var(--mono);font-size:9px;font-weight:600;color:var(--muted2);display:none';
                        evRow.appendChild(se); evRow.appendChild(sev);
                        teamWrap.appendChild(evRow);
                        if (preds[r.id] !== undefined && preds[r.id] !== '') {
                            (function(id){ setTimeout(function(){ updateSideEdge(id); }, 0); })(r.id);
                        }
                        inputRow.appendChild(teamWrap);
                    });
                } else if (mkt === 'Total') {
                    var rA = mktRows[0], rB = mktRows[1];
                    var fdVal = rA && rA.pt != null ? rA.pt : null;
                    var sharedYlvA = (rA && yourLines[rA.id] != null) ? String(yourLines[rA.id]) : '';
                    var sharedYlvB = (rB && yourLines[rB.id] != null) ? String(yourLines[rB.id]) : '';
                    var sharedYlv = sharedYlvA || sharedYlvB;
                    var sharedPh = fdVal != null ? String(fdVal) : '';

                    var colHdr = document.createElement('div');
                    colHdr.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:5px;padding:0 2px';
                    colHdr.innerHTML = '<span style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);min-width:44px;text-align:center;flex-shrink:0"></span>'
                    + '<span style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);width:64px;text-align:center;flex-shrink:0"></span>'
                    + '<span style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);flex:1;text-align:center">Over %</span>'
                    + '<span style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);flex:1;text-align:center">Under %</span>';
                    inputRow.appendChild(colHdr);

                    var totalRow = document.createElement('div');
                    totalRow.style.cssText = 'display:flex;align-items:center;gap:10px';

                    var fdLbl = document.createElement('span');
                    fdLbl.style.cssText = 'font-family:var(--mono);font-size:12px;color:var(--muted);min-width:44px;text-align:center;flex-shrink:0';
                    fdLbl.textContent = fdVal != null ? fdVal : '-';
                    totalRow.appendChild(fdLbl);

                    var lineInpT = document.createElement('input');
                    lineInpT.className = 'mc-inp' + (sharedYlv ? ' line-changed' : '');
                    lineInpT.type = 'number';
                    lineInpT.step = '0.5';
                    lineInpT.placeholder = sharedPh;
                    lineInpT.value = sharedYlv;
                    lineInpT.style.cssText = 'width:64px;flex-shrink:0';
                    lineInpT.addEventListener('input', function() {
                        var v = this.value;
                        [rA, rB].forEach(function(r) {
                            if (!r) return;
                            yourLines[r.id] = v !== '' ? parseFloat(v) : null;
                        });
                        this.classList.toggle('line-changed', this.value !== '');
                        if (rA) updateSideEdge(rA.id);
                        if (rB) updateSideEdge(rB.id);
                    });
                    lineInpT.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter') this.blur();
                    });
                    totalRow.appendChild(lineInpT);

                    if (rA) {
                        var pvalA = preds[rA.id] || '';
                        var overInp = document.createElement('input');
                        overInp.className = 'mc-inp' + (pvalA ? ' filled' : '');
                        overInp.type = 'number';
                        overInp.min = '1';
                        overInp.max = '99';
                        overInp.step = '0.5';
                        overInp.placeholder = 'Over %';
                        overInp.value = pvalA;
                        overInp.dataset.id = rA.id;
                        overInp.style.cssText = 'flex:1;min-width:0';
                        overInp.addEventListener('input', function() {
                            var v = parseFloat(this.value);
                            if (!isNaN(v) && v >= 1 && v <= 99 && underInp) {
                                var other = (100 - v).toFixed(1);
                                underInp.value = other;
                                preds[rB.id] = other;
                                underInp.classList.toggle('filled', true);
                                setPredMobile(underInp);
                            }
                            setPredMobile(this);
                        });
                        overInp.addEventListener('keydown', function(e) {
                            if (e.key === 'Enter') this.blur();
                        });
                        totalRow.appendChild(overInp);
                    }

                    if (rB) {
                        var pvalB = preds[rB.id] || '';
                        var underInp = document.createElement('input');
                        underInp.className = 'mc-inp' + (pvalB ? ' filled' : '');
                        underInp.type = 'number';
                        underInp.min = '1';
                        underInp.max = '99';
                        underInp.step = '0.5';
                        underInp.placeholder = 'Under %';
                        underInp.value = pvalB;
                        underInp.dataset.id = rB.id;
                        underInp.style.cssText = 'flex:1;min-width:0';
                        underInp.addEventListener('input', function() {
                            var v = parseFloat(this.value);
                            if (!isNaN(v) && v >= 1 && v <= 99 && overInp) {
                                var other = (100 - v).toFixed(1);
                                overInp.value = other;
                                preds[rA.id] = other;
                                overInp.classList.toggle('filled', true);
                                setPredMobile(overInp);
                            }
                            setPredMobile(this);
                        });
                        underInp.addEventListener('keydown', function(e) {
                            if (e.key === 'Enter') this.blur();
                        });
                        totalRow.appendChild(underInp);
                    }

                    inputRow.appendChild(totalRow);

                    var edgeRowT = document.createElement('div');
                    edgeRowT.style.cssText = 'display:flex;gap:10px;margin-top:6px;padding-left:118px';
                    if (rA) {
                        var colA = document.createElement('div');
                        colA.style.cssText = 'display:flex;flex-direction:column;align-items:center;flex:1;gap:1px';
                        var seA = document.createElement('span');
                        seA.className = 'mc-side-edge';
                        seA.dataset.id = rA.id;
                        seA.style.cssText = 'font-family:var(--mono);font-size:12px;font-weight:600;text-align:center;color:var(--muted2)';
                        seA.textContent = '';
                        var sevA = document.createElement('span');
                        sevA.className = 'mc-side-ev';
                        sevA.dataset.id = rA.id;
                        sevA.style.cssText = 'font-family:var(--mono);font-size:10px;font-weight:600;text-align:center;color:var(--muted2);display:none';
                        colA.appendChild(seA);
                        colA.appendChild(sevA);
                        var cbA = document.createElement('input');
                        cbA.type = 'checkbox'; cbA.className = 'mc-bet-check'; cbA.dataset.id = rA.id;
                        cbA.checked = !!betTaken[rA.id]; cbA.title = 'Mark bet taken';
                        cbA.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:' + (autoTakenFrom[rA.id] ? '#f5a623' : 'var(--green)') + ';margin-top:4px';
                        cbA.addEventListener('change', function() { toggleBet(this.dataset.id); });
                        colA.appendChild(cbA);
                        if (preds[rA.id] !== undefined && preds[rA.id] !== '') {
                            (function(id){ setTimeout(function(){ updateSideEdge(id); }, 0); })(rA.id);
                        }
                        edgeRowT.appendChild(colA);
                    }
                    if (rB) {
                        var colB = document.createElement('div');
                        colB.style.cssText = 'display:flex;flex-direction:column;align-items:center;flex:1;gap:1px';
                        var seB = document.createElement('span');
                        seB.className = 'mc-side-edge';
                        seB.dataset.id = rB.id;
                        seB.style.cssText = 'font-family:var(--mono);font-size:12px;font-weight:600;text-align:center;color:var(--muted2)';
                        seB.textContent = '';
                        var sevB = document.createElement('span');
                        sevB.className = 'mc-side-ev';
                        sevB.dataset.id = rB.id;
                        sevB.style.cssText = 'font-family:var(--mono);font-size:10px;font-weight:600;text-align:center;color:var(--muted2);display:none';
                        colB.appendChild(seB);
                        colB.appendChild(sevB);
                        var cbB = document.createElement('input');
                        cbB.type = 'checkbox'; cbB.className = 'mc-bet-check'; cbB.dataset.id = rB.id;
                        cbB.checked = !!betTaken[rB.id]; cbB.title = 'Mark bet taken';
                        cbB.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:' + (autoTakenFrom[rB.id] ? '#f5a623' : 'var(--green)') + ';margin-top:4px';
                        cbB.addEventListener('change', function() { toggleBet(this.dataset.id); });
                        colB.appendChild(cbB);
                        if (preds[rB.id] !== undefined && preds[rB.id] !== '') {
                            (function(id){ setTimeout(function(){ updateSideEdge(id); }, 0); })(rB.id);
                        }
                        edgeRowT.appendChild(colB);
                    }
                    inputRow.appendChild(edgeRowT);

                } else if (mkt === 'RFI') {
                    // RFI: Yes (YRFI) / No (NRFI) with Real % and edge
                    var colHdrR = document.createElement('div');
                    colHdrR.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:5px;padding:0 2px';
                    colHdrR.innerHTML = '<span style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);flex-shrink:0;min-width:32px">RFI</span>'
                    + '<span class="mc-adv" style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);width:44px;text-align:center;flex-shrink:0">FD</span>'
                    + '<span style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);width:48px;text-align:center;flex-shrink:0">Real %</span>'
                    + '<span class="mc-adv" style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);margin-left:auto;text-align:right">Edge</span>';
                    inputRow.appendChild(colHdrR);
                    mktRows.forEach(function(r) {
                        var pval = preds[r.id] || '';
                        var sideRow = document.createElement('div');
                        sideRow.className = 'mc-team-wrap';
                        sideRow.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:4px;padding-left:6px;border-left:3px solid transparent;border-radius:1px' + (betTaken[r.id] ? ';opacity:0.4' : '');
                        var sideLbl = document.createElement('span');
                        var rfiColor = r.ps === 'A' ? 'var(--green)' : 'var(--red)';
                        sideLbl.style.cssText = 'font-family:var(--sans);font-size:11px;font-weight:700;color:' + rfiColor + ';flex-shrink:0;min-width:32px';
                        sideLbl.textContent = r.ps === 'A' ? 'YRFI' : 'NRFI';
                        sideRow.appendChild(sideLbl);
                        var fdAmSpan = document.createElement('span');
                        fdAmSpan.className = 'mc-adv';
                        fdAmSpan.style.cssText = 'font-family:var(--mono);font-size:11px;color:var(--muted);width:44px;text-align:center;flex-shrink:0';
                        fdAmSpan.textContent = r.am != null ? (r.am > 0 ? '+' + r.am : r.am) : '-';
                        sideRow.appendChild(fdAmSpan);
                        var predInp = document.createElement('input');
                        predInp.className = 'mc-inp' + (pval ? ' filled' : '');
                        predInp.type = 'number'; predInp.min = '1'; predInp.max = '99'; predInp.step = '0.5';
                        predInp.placeholder = '%'; predInp.value = pval;
                        predInp.dataset.id = r.id; predInp.dataset.type = 'pred';
                        predInp.style.cssText = 'width:48px;flex-shrink:0';
                        predInp.addEventListener('input', function() { setPredMobile(this); });
                        predInp.addEventListener('keydown', function(e) { if (e.key === 'Enter') this.blur(); });
                        sideRow.appendChild(predInp);
                        var evWrap = document.createElement('div');
                        evWrap.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;gap:1px';
                        var sideEdge = document.createElement('span');
                        sideEdge.className = 'mc-side-edge mc-adv';
                        sideEdge.dataset.id = r.id;
                        sideEdge.style.cssText = 'font-family:var(--mono);font-size:12px;font-weight:600;white-space:nowrap;color:var(--muted2);text-align:right';
                        sideEdge.textContent = '-';
                        var sideEV = document.createElement('span');
                        sideEV.className = 'mc-side-ev';
                        sideEV.dataset.id = r.id;
                        sideEV.style.cssText = 'font-family:var(--mono);font-size:10px;font-weight:600;color:var(--muted2);text-align:right;display:none';
                        evWrap.appendChild(sideEdge); evWrap.appendChild(sideEV);
                        sideRow.appendChild(evWrap);
                        var betCbR = document.createElement('input');
                        betCbR.type = 'checkbox'; betCbR.className = 'mc-bet-check'; betCbR.dataset.id = r.id;
                        betCbR.checked = !!betTaken[r.id]; betCbR.title = 'Mark bet taken';
                        betCbR.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:' + (autoTakenFrom[r.id] ? '#f5a623' : 'var(--green)') + ';flex-shrink:0;margin-left:6px';
                        betCbR.addEventListener('change', function() { toggleBet(this.dataset.id); });
                        sideRow.appendChild(betCbR);
                        if (preds[r.id] !== undefined && preds[r.id] !== '') {
                            (function(id){ setTimeout(function(){ updateSideEdge(id); }, 0); })(r.id);
                        }
                        inputRow.appendChild(sideRow);
                    });

                } else {
                    var isWcSpread = (currentSport === 'soccer_wc');
                    var colHdr = document.createElement('div');
                    colHdr.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:5px;padding:0 2px';
                    colHdr.innerHTML = '<span style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);width:58px;text-align:center;flex-shrink:0">Real %</span>'
                    + '<span style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);margin-left:auto;text-align:right">Edge</span>';
                    inputRow.appendChild(colHdr);
                    mktRows.forEach(function(r) {
                        var ylv = (yourLines[r.id] != null) ? String(yourLines[r.id]) : '';
                        var ph = r.pt != null ? String(r.pt) : '';
                        var pval = preds[r.id] || '';
                        var sideRow = document.createElement('div');
                        sideRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:4px';
                        if (!isWcSpread) {
                            var fdLbl = document.createElement('span');
                            fdLbl.style.cssText = 'font-family:var(--mono);font-size:12px;color:var(--muted);min-width:44px;text-align:center;flex-shrink:0';
                            fdLbl.textContent = r.pt != null ? (r.pt > 0 ? '+' + r.pt : r.pt) : '-';
                            sideRow.appendChild(fdLbl);
                            var lineInp = document.createElement('input');
                            lineInp.className = 'mc-inp' + (ylv ? ' line-changed' : '');
                            lineInp.type = 'number';
                            lineInp.step = '0.5';
                            lineInp.placeholder = ph;
                            lineInp.value = ylv;
                            lineInp.dataset.id = r.id;
                            lineInp.dataset.type = 'line';
                            lineInp.style.cssText = 'width:64px;flex-shrink:0';
                            lineInp.addEventListener('blur', function() { setLineMobile(this); });
                            lineInp.addEventListener('input', function() { setLineMobile(this); });
                            lineInp.addEventListener('keydown', function(e) { if (e.key === 'Enter') this.blur(); });
                            sideRow.appendChild(lineInp);
                        }
                        var predInp = document.createElement('input');
                        predInp.className = 'mc-inp' + (pval ? ' filled' : '');
                        predInp.type = 'number';
                        predInp.min = '1';
                        predInp.max = '99';
                        predInp.step = '0.5';
                        predInp.placeholder = '%';
                        predInp.value = pval;
                        predInp.dataset.id = r.id;
                        predInp.dataset.type = 'pred';
                        predInp.style.cssText = 'width:58px;flex-shrink:0';
                        predInp.addEventListener('input', function() { setPredMobile(this); });
                        predInp.addEventListener('keydown', function(e) { if (e.key === 'Enter') this.blur(); });
                        sideRow.appendChild(predInp);
                        var sideEdge = document.createElement('span');
                        sideEdge.className = 'mc-side-edge';
                        sideEdge.dataset.id = r.id;
                        sideEdge.style.cssText = 'font-family:var(--mono);font-size:12px;font-weight:600;margin-left:auto;white-space:nowrap;color:var(--muted2);text-align:right';
                        sideEdge.textContent = '-';
                        var evWrap = document.createElement('div');
                        evWrap.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;gap:1px';
                        evWrap.appendChild(sideEdge);
                        var sideEV = document.createElement('span');
                        sideEV.className = 'mc-side-ev';
                        sideEV.dataset.id = r.id;
                        sideEV.style.cssText = 'font-family:var(--mono);font-size:10px;font-weight:600;color:var(--muted2);text-align:right;display:none';
                        evWrap.appendChild(sideEV);
                        sideRow.appendChild(evWrap);
                        // Bet taken checkbox
                        var betCb = document.createElement('input');
                        betCb.type = 'checkbox';
                        betCb.className = 'mc-bet-check';
                        betCb.dataset.id = r.id;
                        betCb.checked = !!betTaken[r.id];
                        betCb.title = 'Mark bet taken';
                        betCb.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:' + (autoTakenFrom[r.id] ? '#f5a623' : 'var(--green)') + ';flex-shrink:0;margin-left:6px';
                        betCb.addEventListener('change', function() { toggleBet(this.dataset.id); });
                        sideRow.appendChild(betCb);
                        if (betTaken[r.id]) sideRow.style.opacity = '0.4';
                        // Auto-compute if preds already filled
                        if (preds[r.id] !== undefined && preds[r.id] !== '') {
                            (function(id){ setTimeout(function(){ updateSideEdge(id); }, 0); })(r.id);
                        }
                        inputRow.appendChild(sideRow);
                    });
                }
                section.appendChild(inputRow);

                body.appendChild(section);
            });

            card.appendChild(body);
            container.appendChild(card);
        });
    }

    function toggleMobileCard(game) {
        mobileCollapsed[game] = !mobileCollapsed[game];
        document.querySelectorAll('.game-card-body').forEach(function(el) {
            if (el.getAttribute('data-game') === game) {
                el.classList.toggle('collapsed', !!mobileCollapsed[game]);
            }
        });
        document.querySelectorAll('.game-card-header').forEach(function(el) {
            var gk = el.getAttribute('onclick') || '';
            if (gk.indexOf(game.replace(/'/g, "\'")) !== -1) {
                var arrow = el.querySelector('.gc-arrow');
                if (arrow)
                    arrow.classList.toggle('up', !mobileCollapsed[game]);
            }
        });
    }

    function setLineMobile(input) {
        var id = input.getAttribute('data-id');
        yourLines[id] = input.value !== '' ? parseFloat(input.value) : null;
        input.classList.toggle('line-changed', yourLines[id] != null);
        var section = input.parentElement;
        while (section && !section.classList.contains('mc-section')) {
            section = section.parentElement;
        }
        if (!section) return;
        var resultRow = section.querySelector('.mc-result');
        if (!resultRow) return;
        var predInputs = section.querySelectorAll('input[data-id]');
        predInputs.forEach(function(pi) {
            var pid = pi.getAttribute('data-id');
            if (preds[pid]) {
                updateSideEdge(pid);
                if (resultRow) computeAndShowEdge(pid, resultRow);
            }
        });
    }

    var _settingPredMobile = false;

    function setPredMobile(input) {
        var id = input.getAttribute('data-id');
        // Strip decimals — whole numbers only
        if (input.value && input.value.indexOf('.') !== -1) {
            input.value = input.value.replace(/\.\d*/, '');
        }
        preds[id] = input.value;
        delete probsExact[id];
        input.classList.toggle('filled', !!input.value);

        if (!_settingPredMobile && input.value !== '') {
            var r = rawRows.find(function(x) { return x.id === id; });
            if (r && !r._wcFair && (r.mkt === 'ML' || r.mkt === 'RFI' || r.mkt === 'Spread')) {
                var v = parseFloat(input.value);
                if (!isNaN(v) && v >= 1 && v <= 99) {
                    var otherId = r.ps === 'A' ? id.replace(/-A$/, '-B') : id.replace(/-B$/, '-A');
                    var other = (100 - v).toFixed(1);
                    preds[otherId] = other;
                    var otherInp = document.querySelector('.mc-inp[data-id="' + otherId + '"][data-type="pred"]') || document.querySelector('.mc-inp[data-id="' + otherId + '"]');
                    if (otherInp && otherInp !== input) {
                        otherInp.value = other;
                        otherInp.classList.add('filled');
                        _settingPredMobile = true;
                        setPredMobile(otherInp);
                        _settingPredMobile = false;
                    }
                }
            }
        }

        updateSideEdge(id);
        var section = input.parentElement;
        while (section && !section.classList.contains('mc-section')) {
            section = section.parentElement;
        }
        if (!section) return;
        var resultRow = section.querySelector('.mc-result');
        if (resultRow) computeAndShowEdge(id, resultRow);
    }

    function updateSideEdge(id) {
        var r = rawRows.find(function(x) { return x.id === id; });
        if (!r) return;
        var unit = parseFloat(document.getElementById('unit-size').value) || 300;
        var yl = yourLines[r.id] != null ? yourLines[r.id] : null;
        var fair, af;
        if (r._wcFair != null) {
            fair = r._wcFair;
            af   = r._wcFair;
        } else if (r.mkt === 'RFI' && r.rfiFair != null) {
            fair = r.rfiFair;
            af   = r.rfiFair;
        } else {
            var pairs = {};
            rawRows.forEach(function(x) {
                if (!pairs[x.pid]) pairs[x.pid] = {};
                pairs[x.pid][x.ps] = x;
            });
            var pair = pairs[r.pid] || {};
            var nv = novig(pair.A ? imp(pair.A.am) : null, pair.B ? imp(pair.B.am) : null);
            var altNV = getAltFair(r, yl, pair.A, pair.B);
            fair = altNV ? (r.ps === 'A' ? altNV.fa : altNV.fb) : (r.ps === 'A' ? nv.fa : nv.fb);
            af = altNV ? fair : adjFair(fair, r.pt, yl, r.mkt, r.ps);
        }
        var pr = preds[id];
        var pred = (pr !== undefined && pr !== '') ? Math.min(0.999, Math.max(0.001, (probsExact[id] != null ? probsExact[id] : parseFloat(pr) / 100) + rsPredAdj / 100)) : null;
        var edge = (af != null && pred != null && isFinite(pred)) ? (af - pred) * 100 : null;
        var evForU = null;
        if (af != null && pred != null && pred > 0 && pred < 1) {
            evForU = (af * (1/pred) * (1-rsBaseTake(pred)) - 1) * 100;
        }
        var u = (isPro() || r.mkt === 'ML' || r.mkt === 'RFI') ? unitsEV(evForU, pred) : units(edge);
        var bet = u * unit;
        var el = document.querySelector('.mc-side-edge[data-id="' + id + '"]');
        if (!el) return;
        var evEl = document.querySelector('.mc-side-ev[data-id="' + id + '"]');
        // Edge element: hidden on mobile cards — EV element carries all display
        el.style.display = 'none';
        // EV element: units on top line, EV% below (both simple and advanced)
        if (evEl) {
            var showEv = edge != null && evForU != null && evForU > 0 && (dashMode !== 'simple' || u > 0);
            if (showEv) {
                evEl.style.display = '';
                if (isPro() || r.mkt === 'ML' || r.mkt === 'RFI') {
                    var evColor = evForU >= 5 ? 'var(--green)' : 'var(--yellow)';
                    evEl.style.color = evColor;
                    evEl.style.filter = '';
                    evEl.innerHTML = (u > 0 ? '<span style="color:' + evColor + ';display:block">' + u + 'u ' + RAX_ICON + bet.toFixed(0) + '</span>' : '')
                        + '<span style="display:block;color:' + evColor + ';font-size:9px">EV:+' + evForU.toFixed(1) + '%</span>';
                } else {
                    evEl.style.color = 'var(--green)';
                    evEl.style.filter = '';
                    evEl.innerHTML = 'EV:<span style="filter:blur(4px);display:inline-block">+8.4%</span>';
                }
            } else {
                evEl.style.display = 'none';
            }
        }
        // Green left accent on the team row when there's a valued bet
        var wrapEl = el.closest('.mc-team-wrap');
        if (wrapEl) {
            var showAccent = u > 0 && evForU != null && evForU > 0;
            var accentColor = showAccent ? (evForU >= 5 ? 'var(--green)' : 'var(--yellow)') : 'transparent';
            wrapEl.style.borderLeftColor = accentColor;
        }
    }

    function computeAndShowEdge(id, resultRow) {
        var r = rawRows.find(function(x) { return x.id === id; });
        if (!r) return;
        var unit = parseFloat(document.getElementById('unit-size').value) || 300;
        var pairs = {};
        rawRows.forEach(function(x) {
            if (!pairs[x.pid]) pairs[x.pid] = {};
            pairs[x.pid][x.ps] = x;
        });
        var fair, af;
        var yl = yourLines[r.id] != null ? yourLines[r.id] : null;
        if (r._wcFair != null) {
            fair = r._wcFair;
            af   = r._wcFair;
        } else if (r.mkt === 'RFI' && r.rfiFair != null) {
            fair = r.rfiFair;
            af   = r.rfiFair;
        } else {
            var pair = pairs[r.pid] || {};
            var nv = novig(pair.A ? imp(pair.A.am) : null, pair.B ? imp(pair.B.am) : null);
            fair = r.ps === 'A' ? nv.fa : nv.fb;
            af = adjFair(fair, r.pt, yl, r.mkt, r.ps);
        }
        var pr = preds[id];
        var pred = (pr !== undefined && pr !== '') ? parseFloat(pr) / 100 : null;
        var edge = (af != null && pred != null && isFinite(pred)) ? (af - pred) * 100 : null;
        var u = units(edge);
        var bet = u * unit;
        if (edge != null) {
            resultRow.innerHTML = '<span style="font-family:var(--mono);font-size:13px;font-weight:600;color:' + (edge >= 8 ? 'var(--green)' : edge >= 5 ? '#7ddfab' : edge > 0 ? 'var(--yellow)' : 'var(--red)') + '">' + (edge > 0 ? '+' : '') + edge.toFixed(1) + '%</span>'
            + ' <span style="font-family:var(--mono);font-size:12px;font-weight:600;color:' + (u === 0 ? 'var(--muted2)' : 'var(--green)') + '">' + (u === 0 ? 'PASS' : u + 'u') + '</span>'
            + (u > 0 ? ' <span style="font-family:var(--mono);font-size:12px;color:var(--text)">' + RAX_ICON + bet.toFixed(0) + '</span>' : '');
        } else {
            resultRow.innerHTML = '<span style="font-size:11px;color:var(--muted2);font-family:var(--mono)">Enter % to see edge</span>';
        }
    }

    function recomputeAndRenderMobile(unit) {
        if (window.innerWidth > 768) return;
        var q = document.getElementById('search').value.trim().toLowerCase();
        var pairs = {};
        rawRows.forEach(function(r) {
            if (!pairs[r.pid]) pairs[r.pid] = {};
            pairs[r.pid][r.ps] = r;
        });
        var computed = rawRows.map(function(r) {
            var fair, af;
            var yl = yourLines[r.id] != null ? yourLines[r.id] : null;
            if (r._wcFair != null) {
                fair = r._wcFair;
                af   = r._wcFair;
            } else if (r.mkt === 'RFI' && r.rfiFair != null) {
                fair = r.rfiFair;
                af   = r.rfiFair;
            } else {
                var pair = pairs[r.pid] || {};
                var nv = novig(pair.A ? imp(pair.A.am) : null, pair.B ? imp(pair.B.am) : null);
                fair = r.ps === 'A' ? nv.fa : nv.fb;
                af = adjFair(fair, r.pt, yl, r.mkt, r.ps);
            }
            var pr = preds[r.id];
            var pred = (pr !== undefined && pr !== '') ? parseFloat(pr) / 100 : null;
            var edge = (af != null && pred != null && isFinite(pred)) ? (af - pred) * 100 : null;
            var evForUM = null;
            if (af != null && pred != null && pred > 0 && pred < 1) {
                var volNumM = 0;
                if (vols[r.id]) { var vsM = vols[r.id]; volNumM = vsM.endsWith('k') ? parseFloat(vsM)*1000 : vsM.endsWith('m') ? parseFloat(vsM)*1000000 : parseFloat(vsM); }
                var rakeM = volNumM > 100000 ? 0.034 : volNumM > 10000 ? 0.032 : volNumM > 1000 ? 0.035 : volNumM > 0 ? 0.04 : 0.034;
                evForUM = (af * (1/pred) * (1-rakeM) - 1) * 100;
            }
            var u = (isPro() || r.mkt === 'ML' || r.mkt === 'RFI') ? unitsEV(evForUM, pred) : units(edge);
            return Object.assign({}, r, { fair: fair, af: af, yl: yl, edge: edge, u: u, bet: u * unit });
        });
        var filtered = computed.filter(function(r) {
            if (!q) return true;
            return (r.game + ' ' + r.side + ' ' + r.mkt).toLowerCase().indexOf(q) !== -1;
        });
        var mO2 = { ML: 0, Spread: 1, Total: 2 };
        filtered.sort(function(a, b) {
            var ta = a.cm ? a.cm.getTime() : 9e12, tb = b.cm ? b.cm.getTime() : 9e12;
            if (a.game !== b.game) return ta - tb;
            if (a.mkt !== b.mkt) return (mO2[a.mkt] || 0) - (mO2[b.mkt] || 0);
            return 0;
        });
        renderMobileCards(filtered);
    }

    // Admin state
    var currentUser = null;
    var adminSearchTimer = null;
    var adminOffset = 0;
    var adminHasMore = false;

    function showAdminTab() {
        document.getElementById('sport-tabs').style.display = 'none';
        document.getElementById('feature-tabs').style.display = 'none';
        document.querySelector('.controls').style.display = 'none';
        document.querySelector('.status-bar').style.display = 'none';
        document.querySelector('.table-wrap').style.display = 'none';
        document.getElementById('mobile-cards').style.display = 'none';
        document.getElementById('collapse-btn').style.display = 'none';
        document.getElementById('refresh-btn').style.display = 'none';
        document.getElementById('admin-panel').classList.add('visible');
        loadAdminStats();
        loadAdminUsers();
    }

    function hideAdminTab() {
        document.getElementById('sport-tabs').style.display = '';
        document.getElementById('feature-tabs').style.display = '';
        document.querySelector('.controls').style.display = '';
        document.querySelector('.status-bar').style.display = '';
        document.querySelector('.table-wrap').style.display = '';
        document.getElementById('mobile-cards').style.display = '';
        document.getElementById('collapse-btn').style.display = 'none';
        document.getElementById('refresh-btn').style.display = '';
        document.getElementById('admin-panel').classList.remove('visible');
    }

    function showAlertsTab() {
        document.getElementById('sport-tabs').style.display = 'none';
        document.querySelector('.controls').style.display = 'none';
        document.querySelector('.status-bar').style.display = 'none';
        document.querySelector('.table-wrap').style.display = 'none';
        document.getElementById('mobile-cards').style.display = 'none';
        document.getElementById('collapse-btn').style.display = 'none';
        document.getElementById('refresh-btn').style.display = 'none';
        document.getElementById('alerts-panel').classList.add('visible');
        var btn = document.getElementById('alerts-tab-btn');
        if (btn) { btn.classList.add('active'); btn.textContent = '<- Dashboard'; }
        loadAlertsPanel();
    }

    function hideAlertsTab() {
        document.getElementById('sport-tabs').style.display = '';
        document.querySelector('.controls').style.display = '';
        document.querySelector('.status-bar').style.display = '';
        document.querySelector('.table-wrap').style.display = '';
        document.getElementById('mobile-cards').style.display = '';
        document.getElementById('collapse-btn').style.display = 'none';
        document.getElementById('refresh-btn').style.display = '';
        document.getElementById('alerts-panel').classList.remove('visible');
        var btn = document.getElementById('alerts-tab-btn');
        if (btn) { btn.classList.remove('active'); btn.textContent = '🔔 Notify'; }
    }

    function showReferralTab() {
        document.getElementById('sport-tabs').style.display = 'none';
        document.getElementById('feature-tabs').style.display = 'none';
        document.querySelector('.controls').style.display = 'none';
        document.querySelector('.status-bar').style.display = 'none';
        document.querySelector('.table-wrap').style.display = 'none';
        document.getElementById('mobile-cards').style.display = 'none';
        document.getElementById('collapse-btn').style.display = 'none';
        document.getElementById('refresh-btn').style.display = 'none';
        document.getElementById('referral-panel').classList.add('visible');
        loadReferralStats();
    }

    function hideReferralTab() {
        document.getElementById('sport-tabs').style.display = '';
        document.getElementById('feature-tabs').style.display = '';
        document.querySelector('.controls').style.display = '';
        document.querySelector('.status-bar').style.display = '';
        document.querySelector('.table-wrap').style.display = '';
        document.getElementById('mobile-cards').style.display = '';
        document.getElementById('collapse-btn').style.display = 'none';
        document.getElementById('refresh-btn').style.display = '';
        document.getElementById('referral-panel').classList.remove('visible');
    }

    // ── Alerts panel ──────────────────────────────────────

    var _alertsVerified = false;
    var _alertsConnectPoll = null;

    var ALERT_SPORTS = [
        { key: 'basketball_nba',         label: 'NBA'   },
        { key: 'icehockey_nhl',          label: 'NHL'   },
        { key: 'baseball_mlb',           label: 'MLB'   },
        { key: 'basketball_ncaab',       label: 'NCAAB' },
        { key: 'mma_mixed_martial_arts', label: 'UFC'   },
        { key: 'soccer_fc',              label: 'FC'    },
        { key: 'soccer_wc',              label: 'WC'    },
        { key: 'baseball_cws',           label: 'CWS'   },
    ];

    async function loadAlertsPanel() {
        // Build sports checkboxes if not already done
        var grid = document.getElementById('alerts-sports-grid');
        if (!grid.children.length) {
            ALERT_SPORTS.forEach(function(s) {
                var label = document.createElement('label');
                label.style.cssText = 'display:flex;align-items:center;gap:8px;background:var(--bg4);border:1px solid var(--border);border-radius:7px;padding:8px 12px;cursor:pointer;font-size:13px;font-weight:600;color:var(--fg)';
                label.innerHTML = '<input type="checkbox" data-sport="' + s.key + '" checked style="accent-color:var(--accent);width:15px;height:15px" onchange="saveAlertSettings()"> ' + s.label;
                grid.appendChild(label);
            });
        }

        try {
            var res = await fetch('/api/alerts/settings', { credentials: 'same-origin' });
            if (!res.ok) return;
            var data = await res.json();
            var s = data.settings;

            _alertsVerified = s.verified;
            updateAlertConnectUI(s.verified);

            // Populate settings
            var toggle = document.getElementById('alerts-enabled-toggle');
            toggle.checked = s.enabled;
            updateToggleVisual(toggle.checked);

            var slider = document.getElementById('alerts-ev-slider');
            slider.value = s.min_ev;
            document.getElementById('alerts-ev-display').textContent = '+' + parseFloat(s.min_ev).toFixed(1) + '%';

            // Sports checkboxes
            var sportSet = s.sports === 'ALL' ? null : new Set(s.sports.split(',').map(function(x) { return x.trim(); }));
            grid.querySelectorAll('input[data-sport]').forEach(function(cb) {
                cb.checked = !sportSet || sportSet.has(cb.dataset.sport);
            });

            // 1 Side toggle
            var oneSide = document.getElementById('alerts-oneside-toggle');
            oneSide.checked = !!s.one_side;
            updateOneSideVisual(oneSide.checked);

            // Unit size
            document.getElementById('alerts-unit-size').value = s.unit_size || 100;

            loadTakenBets();
        } catch(e) {}
    }

    async function loadTakenBets() {
        try {
            var res = await fetch('/api/alerts/taken', { credentials: 'same-origin' });
            var data = await res.json();
            var bets = data.bets || [];

            // Sync Telegram-tapped bets into dashboard checkboxes (all sports)
            var takenKeys = new Set(bets.map(function(b) { return b.game + '|' + b.market + '|' + b.side; }));
            var allSportRows = [];
            if (window.rawRowsBySport) Object.values(rawRowsBySport).forEach(function(sr) { allSportRows = allSportRows.concat(sr || []); });
            if (!allSportRows.length && window.rawRows) allSportRows = rawRows;
            var changed = false;
            allSportRows.forEach(function(r) {
                var key = r.game + '|' + r.mkt + '|' + r.side;
                if (takenKeys.has(key) && !betTaken[r.id]) {
                    betTaken[r.id] = true;
                    _alertSyncedIds.add(r.id);
                    changed = true;
                } else if (!takenKeys.has(key) && _alertSyncedIds.has(r.id)) {
                    delete betTaken[r.id];
                    _alertSyncedIds.delete(r.id);
                    changed = true;
                }
            });
            if (_alertSyncedIds.size && !bets.length) {
                _alertSyncedIds.forEach(function(id) { delete betTaken[id]; });
                _alertSyncedIds.clear();
                changed = true;
            }
            if (changed) {
                localStorage.setItem('raxedge_bets_taken', JSON.stringify(betTaken));
                renderTable();
            }
        } catch(e) {}
    }

    function updateAlertConnectUI(verified) {
        var connected = document.getElementById('alerts-status-connected');
        var unconnected = document.getElementById('alerts-status-unconnected');
        var settingsSection = document.getElementById('alerts-settings-section');

        if (verified) {
            connected.style.display = 'flex';
            unconnected.style.display = 'none';
            settingsSection.style.opacity = '1';
            settingsSection.style.pointerEvents = '';
        } else {
            connected.style.display = 'none';
            unconnected.style.display = '';
            settingsSection.style.opacity = '0.4';
            settingsSection.style.pointerEvents = 'none';
        }
    }

    function updateToggleVisual(checked) {
        var track = document.getElementById('alerts-toggle-track');
        var thumb = document.getElementById('alerts-toggle-thumb');
        track.style.background = checked ? 'var(--accent)' : 'var(--bg4)';
        thumb.style.background = checked ? '#fff' : '#666';
        thumb.style.transform  = checked ? 'translateX(18px)' : 'translateX(0)';
    }

    function updateOneSideVisual(checked) {
        var track = document.getElementById('alerts-oneside-track');
        var thumb = document.getElementById('alerts-oneside-thumb');
        if (!track) return;
        track.style.background = checked ? 'var(--accent)' : 'var(--bg4)';
        thumb.style.background = checked ? '#fff' : '#666';
        thumb.style.transform  = checked ? 'translateX(18px)' : 'translateX(0)';
    }

    document.addEventListener('change', function(e) {
        if (e.target && e.target.id === 'alerts-enabled-toggle') {
            updateToggleVisual(e.target.checked);
        }
        if (e.target && e.target.id === 'alerts-oneside-toggle') {
            updateOneSideVisual(e.target.checked);
        }
    });

    async function connectTelegram() {
        var btn = document.getElementById('alerts-connect-btn');
        var status = document.getElementById('alerts-connect-status');
        btn.disabled = true;
        btn.textContent = 'Generating link…';
        status.style.display = 'none';

        try {
            var res = await fetch('/api/alerts/connect', { method: 'POST', credentials: 'same-origin' });
            var data = await res.json();
            if (!data.ok || !data.deepLink) throw new Error(data.error || 'Failed');

            // Open Telegram deep link
            window.open(data.deepLink, '_blank');

            btn.textContent = 'Waiting for Telegram…';
            status.textContent = 'Link opened — press Start in the bot chat, then come back here.';
            status.style.display = '';
            status.style.color = 'var(--muted)';

            // Poll every 3s to check if verification completed (up to 10 min)
            if (_alertsConnectPoll) clearInterval(_alertsConnectPoll);
            var pollCount = 0;
            _alertsConnectPoll = setInterval(async function() {
                pollCount++;
                if (pollCount > 200) { clearInterval(_alertsConnectPoll); return; }
                try {
                    var r = await fetch('/api/alerts/settings', { credentials: 'same-origin' });
                    var d = await r.json();
                    if (d.settings && d.settings.verified) {
                        clearInterval(_alertsConnectPoll);
                        _alertsVerified = true;
                        updateAlertConnectUI(true);
                        btn.disabled = false;
                        btn.textContent = 'Open Telegram to Connect →';
                        status.style.display = 'none';
                        try { posthog.capture('telegram_connected'); } catch(e) {}
                    }
                } catch(e) {}
            }, 3000);

        } catch(e) {
            btn.disabled = false;
            btn.textContent = 'Open Telegram to Connect →';
            status.textContent = 'Error: ' + e.message;
            status.style.display = '';
            status.style.color = 'var(--red)';
        }
    }

    async function disconnectTelegram() {
        showConfirm('Disconnect Telegram? You will stop receiving alerts.', async function() { await _doDisconnectTelegram(); });
        return;
    }
    async function _doDisconnectTelegram() {
        try {
            await fetch('/api/alerts/connect', { method: 'DELETE', credentials: 'same-origin' });
            _alertsVerified = false;
            updateAlertConnectUI(false);
        } catch(e) {}
    }

    async function saveAlertSettings() {
        if (!_alertsVerified) return;
        var enabled  = document.getElementById('alerts-enabled-toggle').checked;
        var minEv    = parseFloat(document.getElementById('alerts-ev-slider').value);
        var oneSide  = document.getElementById('alerts-oneside-toggle').checked;
        var unitSize = parseFloat(document.getElementById('alerts-unit-size').value) || 100;

        var sportChecks = document.querySelectorAll('#alerts-sports-grid input[data-sport]');
        var checked = Array.from(sportChecks).filter(function(c) { return c.checked; }).map(function(c) { return c.dataset.sport; });
        var sports = checked.length === ALERT_SPORTS.length ? 'ALL' : checked.join(',');

        try {
            await fetch('/api/alerts/settings', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: enabled, min_ev: minEv, sports: sports, one_side: oneSide, unit_size: unitSize })
            });
        } catch(e) {}
    }

    function switchConnectTab(tab) {
        var isMobile = tab === 'mobile';
        document.getElementById('port-tab-mobile').classList.toggle('active', isMobile);
        document.getElementById('port-tab-desktop').classList.toggle('active', !isMobile);
        document.getElementById('port-panel-mobile').style.display = isMobile ? '' : 'none';
        document.getElementById('port-panel-desktop').style.display = isMobile ? 'none' : '';
    }

    function copyMobileScript() {
        var script = window._bmScript;
        if (!script) return;
        var btn = document.getElementById('port-copy-mobile-btn');
        navigator.clipboard.writeText(script).then(function() {
            if (btn) { btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = 'Copy'; }, 2000); }
        }).catch(function() {
            var ta = document.createElement('textarea');
            ta.value = script;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            if (btn) { btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = 'Copy'; }, 2000); }
        });
    }

    function showPortfolioTab() {
        document.getElementById('sport-tabs').style.display = 'none';
        document.getElementById('feature-tabs').style.display = 'none';
        document.querySelector('.controls').style.display = 'none';
        document.querySelector('.status-bar').style.display = 'none';
        document.querySelector('.table-wrap').style.display = 'none';
        document.getElementById('mobile-cards').style.display = 'none';
        document.getElementById('collapse-btn').style.display = 'none';
        document.getElementById('refresh-btn').style.display = 'none';
        document.getElementById('portfolio-panel').classList.add('visible');
        loadPortfolio(false);
    }

    function hidePortfolioTab() {
        document.getElementById('sport-tabs').style.display = '';
        document.getElementById('feature-tabs').style.display = '';
        document.querySelector('.controls').style.display = '';
        document.querySelector('.status-bar').style.display = '';
        document.querySelector('.table-wrap').style.display = '';
        document.getElementById('mobile-cards').style.display = '';
        document.getElementById('collapse-btn').style.display = 'none';
        document.getElementById('refresh-btn').style.display = '';
        document.getElementById('portfolio-panel').classList.remove('visible');
    }

    function showEvTab() {
        document.getElementById('sport-tabs').style.display = 'none';
        document.getElementById('feature-tabs').style.display = 'none';
        document.querySelector('.controls').style.display = 'none';
        document.querySelector('.status-bar').style.display = 'none';
        document.querySelector('.table-wrap').style.display = 'none';
        document.getElementById('mobile-cards').style.display = 'none';
        document.getElementById('collapse-btn').style.display = 'none';
        document.getElementById('refresh-btn').style.display = 'none';
        document.getElementById('ev-panel').classList.add('visible');
        // collapse-btn is now in the hamburger dropdown — no display toggle needed here
        // Stop all native sport pollers — they share the rawRows/currentSport globals
        // and would race with loadAllEvSports' sequential phase, causing cross-sport
        // contamination in evTabCache (e.g. FC rows written under 'baseball_mlb' key).
        // loadAllEvSports uses its own 15s refresh timer to keep EV data fresh.
        if (currentLoadAbort) { currentLoadAbort.abort(); currentLoadAbort = null; }
        if (nbaPoller)  { clearInterval(nbaPoller);  nbaPoller  = null; }
        if (wnbaPoller) { clearInterval(wnbaPoller); wnbaPoller = null; }
        if (mlbPoller)  { clearInterval(mlbPoller);  mlbPoller  = null; }
        if (nhlPoller)  { clearInterval(nhlPoller);  nhlPoller  = null; }
        if (dkPoller)   { clearInterval(dkPoller);   dkPoller   = null; }
        if (fcPoller)   { clearInterval(fcPoller);   fcPoller   = null; }
        try { posthog.capture('best_ev_opened'); } catch(e) {}
        evTabVisible = true;
        initEvHideTaken();
        // Sync unit size from main dashboard
        var mainUnit = document.getElementById('unit-size');
        var evUnit = document.getElementById('ev-unit-size');
        if (mainUnit && evUnit) evUnit.value = mainUnit.value;
        // Restore saved min EV floor
        var evMinEl = document.getElementById('ev-min-ev');
        if (evMinEl) evMinEl.value = evMinEv;
        // Render from preloader cache instantly, then refresh in background
        if (Object.keys(evTabCache).length > 0) renderEvTab();
        // Auto-load on open, then refresh every 15s
        loadAllEvSports();
        if (!evAutoRefreshTimer) {
            evAutoRefreshTimer = setInterval(function() {
                if (evTabVisible && !document.hidden) loadAllEvSports();
            }, EV_REFRESH_MS);
        }
    }

    function hideEvTab() {
        document.getElementById('sport-tabs').style.display = '';
        document.getElementById('feature-tabs').style.display = '';
        document.querySelector('.controls').style.display = '';
        document.querySelector('.status-bar').style.display = '';
        document.querySelector('.table-wrap').style.display = '';
        document.getElementById('mobile-cards').style.display = '';
        document.getElementById('collapse-btn').style.display = 'none';
        document.getElementById('refresh-btn').style.display = '';
        document.getElementById('ev-panel').classList.remove('visible');
        evTabVisible = false;
        if (evAutoRefreshTimer) { clearInterval(evAutoRefreshTimer); evAutoRefreshTimer = null; }
        renderTable();
    }

    // ── OTD Tab ────────────────────────────────────────────────────────────────

    var OTD_COLORS = ['#4fc3f7','#ef5350','#66bb6a','#ffa726','#ab47bc','#26c6da','#ff7043','#42a5f5'];
    var OTD_SPORTS = [
        { key: 'mlb', label: 'MLB' }, { key: 'nba', label: 'NBA' },
        { key: 'nhl', label: 'NHL' }, { key: 'nfl', label: 'NFL' },
        { key: 'nba', label: 'NBA' }
    ];
    var OTD_LEVEL_OPTIONS = (function() {
        var opts = [
            { value: 0, label: 'General' }, { value: 1, label: 'Common' },
            { value: 2, label: 'Uncommon' }, { value: 3, label: 'Rare' },
            { value: 4, label: 'Epic' }
        ];
        for (var i = 1; i <= 5; i++) opts.push({ value: 4 + i, label: 'Legendary ' + i });
        for (var i = 1; i <= 10; i++) opts.push({ value: 9 + i, label: 'Mystic ' + i });
        for (var i = 1; i <= 20; i++) opts.push({ value: 19 + i, label: 'Iconic ' + i });
        return opts;
    })();
    var OTD_SPORTS_LIST = [
        { key: 'mlb',    label: 'MLB' },
        { key: 'nba',    label: 'NBA' },
        { key: 'nhl',    label: 'NHL' },
        { key: 'nfl',    label: 'NFL' },
        { key: 'wnba',   label: 'WNBA' },
        { key: 'golf',   label: 'Golf' },
        { key: 'ufc',    label: 'UFC / MMA' },
        { key: 'ncaaf',  label: 'CFB' },
        { key: 'ncaabb', label: 'CBB' },
        { key: 'soccer', label: 'Soccer' },
    ];

    // Cross-year sports: season N = "N-(N+1)" display. Single-year: just "N" abbreviated.
    var OTD_CROSS_YEAR_SPORTS = { nfl:1, nba:1, nhl:1, ncaaf:1, ncaam:1, ncaab:1, ncaabb:1, epl:1, ucl:1, soccer:1, fc:1, mls:1, fifa:1 };
    // RS stores these sports' seasons by ENDING year (e.g. NBA season=2026 = the 2025-26 season)
    var OTD_ENDING_YEAR_SPORTS = { nba:1, nhl:1, ncaab:1, ncaabb:1, ncaam:1 };
    function otdFormatSeason(sport, season) {
        var yr = parseInt(season, 10);
        if (!yr) return String(season);
        if (OTD_CROSS_YEAR_SPORTS[sport]) {
            if (OTD_ENDING_YEAR_SPORTS[sport]) {
                // season=2026 means the 2025-26 season
                return String(yr - 1).slice(-2) + '-' + String(yr).slice(-2);
            }
            return String(yr).slice(-2) + '-' + String(yr + 1).slice(-2);
        }
        return String(yr).slice(-2);
    }

    function otdSeasonOpts(sport, selected) {
        var curYear = new Date().getFullYear();
        var years = [];
        for (var y = curYear; y >= 2015; y--) years.push(y);
        return years.map(function(y) {
            var label = otdFormatSeason(sport, y);
            var sel = selected && String(selected) === String(y) ? ' selected' : (!selected && y === curYear ? ' selected' : '');
            return '<option value="' + y + '"' + sel + '>' + label + '</option>';
        }).join('');
    }

    function otdUpdateSeasonOpts(sport) {
        var sel = document.getElementById('otd-season-sel');
        if (!sel) return;
        var cur = sel.value;
        sel.innerHTML = otdSeasonOpts(sport, cur);
    }

    var otdVisible = false;
    var otdPlayers = []; // { id, name, sport, season, level, levelLabel, color, earnings }
    var otdSearchTimer = null;
    var otdSelectedPlayer = null; // { id, name, sport } from autocomplete
    var otdColorIdx = 0;
    var otdCalYear = new Date().getFullYear();
    var otdCalMonth = new Date().getMonth(); // 0-indexed
    var otdMode = 'player'; // 'player' | 'username'
    var otdSelectedUser = null; // { id, username, displayName }
    var otdUserSearchTimer = null;
    var otdLoadingPasses = false;
    var otdClaimsView = 2; // 2 = default (free), 3 = Pro
    var otdSelectedDay = null; // ISO date string of clicked cell
    var otdSelectedDaySport = null; // active sport tab in day panel
    var otdDateMap = {}; // built by renderOtdResults, used by overlap check
    var otdOverlapMap = {}; // dayKey → [{sport, wasted:[{player,rax}]}] — entries past claim limit >199 Rax
    var otdShowOverlaps = false;
    var otdOverlapSort = 'rax-desc'; // 'rax-desc' | 'rax-asc' | 'date-asc' | 'date-desc'
    var otdCheckMode = false;
    var otdCheckSport = 'mlb'; // persists sport selection even before a player is picked
    var otdCheckPlayer = null; // { id, name, sport, season, level, levelLabel, entityType }
    var otdCheckEarnings = null;
    var otdCheckLoading = false;
    var otdCheckDebug = null;
    var otdCheckSearchTimer = null;
    var otdFindMode = false;
    var otdFindPlayer = null; // { id, name, sport, season, level, levelLabel }
    var otdFindEarnings = null;
    var otdFindLoading = false;
    var otdFindSearchTimer = null;
    var otdFindExpandedMonths = {}; // { monthIndex: true } — which months are expanded in More Info
    var otdPassesOpen = false;
    var otdPassesSearch = '';
    var otdSelectedPass = null;
    var otdSelectedPassMonth = null;

    function otdPrevMonth() {
        if (otdCalMonth === 0) { otdCalMonth = 11; otdCalYear--; } else { otdCalMonth--; }
        otdSelectedDay = null; otdSelectedDaySport = null;
        renderOtdResults();
    }
    function otdNextMonth() {
        if (otdCalMonth === 11) { otdCalMonth = 0; otdCalYear++; } else { otdCalMonth++; }
        otdSelectedDay = null; otdSelectedDaySport = null;
        renderOtdResults();
    }
    function otdSetClaimsView(n) {
        if (n === 3 && !isPro()) return;
        otdClaimsView = n;
        renderOtdResults();
    }
    function otdToggleOverlaps() {
        otdShowOverlaps = !otdShowOverlaps;
        renderOtdResults();
    }
    function otdSetOverlapSort(mode) {
        otdOverlapSort = mode;
        renderOtdResults();
    }
    function otdSelectDay(iso) {
        otdSelectedDay = (otdSelectedDay === iso) ? null : iso;
        otdSelectedDaySport = null;
        renderOtdResults();
    }
    function otdCloseDay() {
        otdSelectedDay = null; otdSelectedDaySport = null;
        renderOtdResults();
    }
    function otdSelectDaySport(sport) {
        otdSelectedDaySport = sport;
        renderOtdResults();
    }

    // RS URL hashids encoder: salt='routing', minLen=11. Encodes [routeType, sportCode, 0, entityId].
    var RS_SPORT_CODE = {nba:1,nfl:2,ncaam:3,mlb:4,epl:5,ucl:6,nhl:7,mls:8,fifa:9,ufc:10,ncaaf:11,wnba:12,soccer:14,golf:15,ncaabb:16};
    function rsUrlHash(a,b,c,d) {
      var salt='routing'.split(''),minLen=11;
      function shuf(x,s){var t=[].concat(x),v=0,p=0,int;for(var i=t.length-1;i>0;i--,v++){v%=s.length;p+=int=s[v].codePointAt(0);var j=(int+v+p)%i;var q=t[i];t[i]=t[j];t[j]=q;}return t;}
      function enc(n,x){var r=[];do{r.unshift(x[n%x.length]);n=Math.floor(n/x.length);}while(n>0);return r;}
      var al='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'.split('');
      var sp='cfhistuCFHISTU'.split('');
      var uniq=Array.from(new Set(al));
      al=uniq.filter(function(x){return sp.indexOf(x)<0;});
      sp=shuf(sp.filter(function(x){return uniq.indexOf(x)>=0;}),salt);
      if(!sp.length||al.length/sp.length>3.5){var sl=Math.ceil(al.length/3.5);if(sl>sp.length){sp=sp.concat(al.slice(0,sl-sp.length));al=al.slice(sl-sp.length);}}
      al=shuf(al,salt);
      var gc=Math.ceil(al.length/12),gd;
      if(al.length<3){gd=sp.splice(0,gc);}else{gd=al.splice(0,gc);}
      var nums=[a,b,c,d];
      var nid=nums.reduce(function(s,n,i){return s+n%(i+100);},0);
      var lot=[al[nid%al.length]];
      var ret=lot.slice();
      for(var i=0;i<nums.length;i++){
        al=shuf(al.slice(),lot.concat(salt,al));
        var en=enc(nums[i],al);
        ret=ret.concat(en);
        if(i+1<nums.length){var pp=en[0].codePointAt(0)+i;ret.push(sp[nums[i]%pp%sp.length]);}
      }
      if(ret.length<minLen)ret.unshift(gd[(nid+ret[0].codePointAt(0))%gd.length]);
      if(ret.length<minLen)ret.push(gd[(nid+ret[2].codePointAt(0))%gd.length]);
      var half=Math.floor(al.length/2);
      while(ret.length<minLen){al=shuf(al.slice(),al);ret=al.slice(half).concat(ret).concat(al.slice(0,half));var ex=ret.length-minLen;if(ex>0)ret=ret.slice(Math.floor(ex/2),Math.floor(ex/2)+minLen);}
      return ret.join('');
    }
    function rsEntityUrl(entityType, sport, entityId) {
      return 'https://www.realapp.com/' + rsUrlHash((entityType === 'player') ? 2 : 3, RS_SPORT_CODE[sport] || 0, 0, entityId);
    }

    function otdDayEarningsEntry(entityId, sport, entityType, calDay) {
        var url = '/api/real/otd?action=day_earnings&day=' + encodeURIComponent(calDay);
        return fetch(url, { credentials: 'same-origin' })
            .then(function(r) { return r.json(); })
            .then(function(d) {
                return (d.entries || []).find(function(e) {
                    return String(e.entityId) === String(entityId) && e.sport === sport && e.entityType === entityType;
                }) || null;
            });
    }

    function otdOpenCardLink(entityId, sport, entityType, calDay, passId) {
        if (passId) {
            var sportCode = RS_SPORT_CODE[sport] || 0;
            window.open('https://www.realapp.com/' + rsUrlHash(18, sportCode, 0, parseInt(passId, 10)), '_blank');
            return;
        }
        otdDayEarningsEntry(entityId, sport, entityType, calDay)
            .then(function(entry) { window.open((entry && entry.cardUrl) || 'https://www.realapp.com', '_blank'); })
            .catch(function() { window.open('https://www.realapp.com', '_blank'); });
    }

    function otdOpenPerfLink(entityId, sport, entityType, calDay, season, bsId) {
        var fallback = rsEntityUrl(entityType, sport, parseInt(entityId, 10));
        // Fast path: boxscore ID already in earnings data — build URL directly, no API call
        var bsIdNum = bsId ? parseInt(bsId, 10) : 0;
        if (bsIdNum > 0) {
            window.open('https://www.realapp.com/' + rsUrlHash(14, 0, 0, bsIdNum), '_blank');
            return;
        }
        if (!entityId || !calDay || !season) { window.open(fallback, '_blank'); return; }
        fetch('/api/real/otd?action=perf_url&id=' + encodeURIComponent(entityId) +
            '&sport=' + encodeURIComponent(sport) +
            '&entityType=' + encodeURIComponent(entityType || 'player') +
            '&season=' + encodeURIComponent(season) +
            '&day=' + encodeURIComponent(calDay), { credentials: 'same-origin' })
            .then(function(r) { return r.json(); })
            .then(function(d) { window.open((d.ok && d.url) || fallback, '_blank'); })
            .catch(function() { window.open(fallback, '_blank'); });
    }

    function otdToggleCheck() {
        otdCheckMode = !otdCheckMode;
        if (!otdCheckMode) { otdCheckPlayer = null; otdCheckEarnings = null; otdCheckLoading = false; }
        renderOtdPanel();
    }

    function otdCheckSearchInput(val) {
        clearTimeout(otdCheckSearchTimer);
        var ac = document.getElementById('otd-check-ac');
        if (!ac) return;
        if (!val || val.length < 2) {
            ac.style.display = 'none';
            if (!val) { otdCheckPlayer = null; otdCheckEarnings = null; renderOtdCheckWrap(); }
            return;
        }
        var sport = (document.getElementById('otd-check-sport') || {}).value || 'mlb';
        otdCheckSearchTimer = setTimeout(function() {
            fetch('/api/real/otd?action=search&q=' + encodeURIComponent(val) + '&sport=' + sport, { credentials: 'same-origin' })
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    var ac2 = document.getElementById('otd-check-ac');
                    if (!ac2) return;
                    var items = (d.players || []).map(function(p) {
                        return '<div style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border2)" ' +
                            'onmousedown="otdCheckSelectPlayer(\'' + escHtml(String(p.id)) + '\',\'' + escHtml(p.name).replace(/'/g, '&#39;') + '\',\'' + sport + '\',\'' + escHtml(p.avatar || '') + '\')">' +
                            escHtml(p.name) + '</div>';
                    }).join('');
                    ac2.innerHTML = items || '<div style="padding:8px 12px;color:var(--muted);font-size:13px">No results</div>';
                    ac2.style.display = '';
                }).catch(function() {});
        }, 300);
    }

    function otdCheckSelectPlayer(id, name, sport, avatar) {
        var ac = document.getElementById('otd-check-ac');
        if (ac) ac.style.display = 'none';
        var inp = document.getElementById('otd-check-input');
        if (inp) inp.value = name;
        var season = String((document.getElementById('otd-check-season') || {}).value || new Date().getFullYear());
        var level = parseInt((document.getElementById('otd-check-level') || {}).value || '4', 10);
        var lbl = (OTD_LEVEL_OPTIONS.find(function(o) { return o.value === level; }) || {}).label || 'Level ' + level;
        otdCheckPlayer = { id: String(id), name: name, sport: sport, season: season, level: level, levelLabel: lbl, entityType: 'player', avatar: avatar || '' };
        otdCheckEarnings = null;
        renderOtdCheckWrap();
    }

    function otdCheckSportChange(sport) {
        otdCheckSport = sport;
        otdCheckPlayer = null; otdCheckEarnings = null;
        renderOtdCheckWrap();
        // Clear the input and autocomplete after re-render
        var inp = document.getElementById('otd-check-input');
        if (inp) inp.value = '';
        var ac = document.getElementById('otd-check-ac');
        if (ac) ac.style.display = 'none';
    }

    function otdClear() {
        otdPlayers = []; otdColorIdx = 0;
        otdSelectedPlayer = null; otdSelectedUser = null;
        otdCheckMode = false; otdCheckPlayer = null; otdCheckEarnings = null; otdCheckLoading = false;
        otdFindMode = false; otdFindPlayer = null; otdFindEarnings = null; otdFindLoading = false;
        otdSelectedDay = null; otdSelectedDaySport = null; otdLoadingPasses = false;
        renderOtdPanel();
    }

    function otdChangeLevel(idx, newLevel) {
        var p = otdPlayers[idx];
        if (!p || p.level === newLevel) return;
        var lbl = (OTD_LEVEL_OPTIONS.find(function(o) { return o.value === newLevel; }) || {}).label || 'Level ' + newLevel;
        p.level = newLevel; p.levelLabel = lbl; p.earnings = null;
        p.rarityColor = otdRarityColor(newLevel); p.backgroundSource = null;
        // If Find Player More Info is showing this player, sync level and clear stale earnings
        if (otdFindPlayer && String(otdFindPlayer.id) === String(p.id) && otdFindPlayer.sport === p.sport) {
            otdFindPlayer.level = newLevel; otdFindPlayer.levelLabel = lbl; otdFindEarnings = null;
        }
        // Don't call renderOtdResults here — wiping earnings would trigger the loading screen.
        // Calendar updates when the fetch below completes.
        renderOtdChips(); renderOtdCheckWrap();
        fetch('/api/real/otd?action=earnings&id=' + p.id + '&sport=' + p.sport + '&season=' + p.season + '&level=' + p.level + '&entityType=' + (p.entityType || 'player'), { credentials: 'same-origin' })
            .then(function(r) { return r.ok ? r.json() : { ok: false }; })
            .then(function(d) {
                p.earnings = (d.ok && d.earnings) ? d.earnings : [];
                // Feed results into Find Player panel if it's still showing this player at this level
                if (otdFindPlayer && String(otdFindPlayer.id) === String(p.id) && otdFindPlayer.sport === p.sport && otdFindPlayer.level === newLevel) {
                    otdFindEarnings = p.earnings;
                }
                renderOtdChips(); renderOtdResults(); renderOtdCheckWrap();
            })
            .catch(function() { p.earnings = []; renderOtdChips(); renderOtdResults(); renderOtdCheckWrap(); });
    }

    function otdToggleFind() {
        otdFindMode = !otdFindMode;
        if (!otdFindMode) { otdFindPlayer = null; otdFindEarnings = null; otdFindLoading = false; }
        renderOtdCheckWrap(); renderOtdResults();
    }

    function otdFindSearchInput(val) {
        clearTimeout(otdFindSearchTimer);
        var ac = document.getElementById('otd-find-ac');
        if (!ac) return;
        if (!val || val.length < 2) { ac.style.display = 'none'; return; }
        var sport = (document.getElementById('otd-find-sport') || {}).value || 'mlb';
        otdFindSearchTimer = setTimeout(function() {
            fetch('/api/real/otd?action=search&q=' + encodeURIComponent(val) + '&sport=' + sport, { credentials: 'same-origin' })
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    var ac2 = document.getElementById('otd-find-ac');
                    if (!ac2) return;
                    var items = (d.players || []).map(function(p) {
                        return '<div style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border2)" ' +
                            'onmousedown="otdFindSelectPlayer(\'' + escHtml(String(p.id)) + '\',\'' + escHtml(p.name).replace(/'/g, '&#39;') + '\',\'' + sport + '\',\'' + escHtml(p.avatar || '') + '\')">' +
                            escHtml(p.name) + '</div>';
                    }).join('');
                    ac2.innerHTML = items || '<div style="padding:8px 12px;color:var(--muted);font-size:13px">No results</div>';
                    ac2.style.display = '';
                }).catch(function() {});
        }, 300);
    }

    function otdFindSelectPlayer(id, name, sport, avatar) {
        var ac = document.getElementById('otd-find-ac');
        if (ac) ac.style.display = 'none';
        var inp = document.getElementById('otd-find-input');
        if (inp) inp.value = name;
        var season = String((document.getElementById('otd-find-season') || {}).value || new Date().getFullYear());
        var existing = otdPlayers.find(function(p) { return String(p.id) === String(id) && p.sport === sport; });
        var level = existing ? existing.level : 4;
        var lbl = (OTD_LEVEL_OPTIONS.find(function(o) { return o.value === level; }) || {}).label || 'Epic';
        otdFindPlayer = { id: String(id), name: name, sport: sport, season: season, level: level, levelLabel: lbl };
        otdFindEarnings = null; otdFindExpandedMonths = {};
        otdRunFind();
    }

    function otdFindToggleMonth(m) {
        otdFindExpandedMonths[m] = !otdFindExpandedMonths[m];
        renderOtdCheckWrap();
    }

    function otdFindChangeRarity(newLevel) {
        if (!otdFindPlayer) return;
        var lbl = (OTD_LEVEL_OPTIONS.find(function(o) { return o.value === newLevel; }) || {}).label || 'Level ' + newLevel;
        var chipIdx = -1;
        otdPlayers.forEach(function(p, i) { if (String(p.id) === String(otdFindPlayer.id) && p.sport === otdFindPlayer.sport) chipIdx = i; });
        if (chipIdx >= 0) {
            otdChangeLevel(chipIdx, newLevel); // syncs otdFindPlayer level + re-fetches via otdChangeLevel
            return;
        }
        otdFindPlayer.level = newLevel; otdFindPlayer.levelLabel = lbl;
        otdFindEarnings = null; otdFindExpandedMonths = {};
        otdRunFind();
    }

    function otdRunFind() {
        if (!otdFindPlayer) return;
        var fp = otdFindPlayer;
        var season = String((document.getElementById('otd-find-season') || {}).value || fp.season);
        var existing = otdPlayers.find(function(p) { return String(p.id) === String(fp.id) && p.sport === fp.sport; });
        var level = existing ? existing.level : (fp.level || 4);
        var lbl = (OTD_LEVEL_OPTIONS.find(function(o) { return o.value === level; }) || {}).label || 'Epic';
        fp.season = season; fp.level = level; fp.levelLabel = lbl;
        otdFindLoading = true; otdFindEarnings = null; otdFindExpandedMonths = {};
        renderOtdCheckWrap();
        fetch('/api/real/otd?action=earnings&id=' + fp.id + '&sport=' + fp.sport + '&season=' + fp.season + '&level=' + fp.level + '&entityType=player&force=1', { credentials: 'same-origin' })
            .then(function(r) { return r.ok ? r.json() : { ok: false }; })
            .then(function(d) {
                otdFindLoading = false;
                otdFindEarnings = (d.ok && d.earnings) ? d.earnings : [];
                renderOtdCheckWrap(); renderOtdResults();
            })
            .catch(function() { otdFindLoading = false; otdFindEarnings = []; renderOtdCheckWrap(); renderOtdResults(); });
    }

    function otdTogglePasses() {
        otdPassesOpen = !otdPassesOpen;
        if (!otdPassesOpen) {
            otdPassesSearch = '';
            otdSelectedPass = null;
            otdSelectedPassMonth = null;
            otdFindEarnings = null;
            otdFindPlayer = null;
        }
        renderOtdCheckWrap();
        renderOtdResults();
    }

    function otdSelectPass(playerIdx) {
        var p = otdPlayers[playerIdx];
        if (!p) return;
        var savedScroll = (document.getElementById('otd-passes-list') || {}).scrollTop || 0;
        if (otdSelectedPass === p) {
            otdSelectedPass = null;
            otdSelectedPassMonth = null;
            otdFindEarnings = null;
            otdFindPlayer = null;
        } else {
            otdSelectedPass = p;
            otdSelectedPassMonth = null;
            otdFindEarnings = p.earnings;
            otdFindPlayer = { id: p.id, name: p.name, sport: p.sport, season: p.season, level: p.level || 4, levelLabel: p.levelLabel || '' };
        }
        renderOtdResults();
        var listEl = document.getElementById('otd-passes-list');
        if (listEl && savedScroll) listEl.scrollTop = savedScroll;
    }

    function otdSelectPassMonth(mk) {
        otdSelectedPassMonth = (otdSelectedPassMonth === mk) ? null : mk;
        var listEl = document.getElementById('otd-passes-list');
        if (listEl) listEl.innerHTML = buildOtdPassesList();
    }

    function otdPassesSearchInput(val) {
        otdPassesSearch = val;
        var listEl = document.getElementById('otd-passes-list');
        if (listEl) listEl.innerHTML = buildOtdPassesList();
    }

    function buildBreakdownCard(p) {
        if (!p || !p.earnings) return '';
        var MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var rc = p.rarityColor || otdRarityColor(p.level);
        var monthMap = {};
        p.earnings.forEach(function(e) {
            var dp = (e.day || '').split('T')[0].split('-');
            if (dp.length !== 3) return;
            var mk = dp[0] + '-' + dp[1].padStart(2, '0');
            if (!monthMap[mk]) monthMap[mk] = [];
            monthMap[mk].push({ rax: e.atRarityEarnings || 0, origDay: (e.day || '').split('T')[0] });
        });
        var months = Object.keys(monthMap).sort();
        if (!months.length) return '';
        var monthYears = months.map(function(mk) { return mk.split('-')[0]; });
        var multiYear = monthYears[0] !== monthYears[monthYears.length - 1];
        var monthBtns = months.map(function(mk) {
            var parts = mk.split('-');
            var mi = parseInt(parts[1], 10) - 1;
            var total = monthMap[mk].reduce(function(s, e) { return s + e.rax; }, 0);
            var isAct = otdSelectedPassMonth === mk;
            var lbl = MONTH_SHORT[mi] + (multiYear ? ' \'' + parts[0].slice(2) : '');
            return '<button onclick="otdSelectPassMonth(\'' + mk + '\')" style="background:' + (isAct ? rc + '33' : rc + '11') + ';border:1px solid ' + (isAct ? rc + '99' : rc + '33') + ';border-radius:6px;padding:5px 4px;cursor:pointer;text-align:center;font-family:var(--sans);width:100%">' +
                '<div style="font-size:9px;font-weight:700;color:' + (isAct ? 'var(--fg)' : 'var(--muted2)') + '">' + lbl + '</div>' +
                '<div style="font-size:10px;font-weight:700;font-family:var(--mono);color:' + (isAct ? rc : 'var(--accent)') + ';margin-top:1px">' + total.toLocaleString() + '</div>' +
            '</button>';
        }).join('');
        var claimsHtml = '';
        if (otdSelectedPassMonth && monthMap[otdSelectedPassMonth]) {
            var entries = monthMap[otdSelectedPassMonth].slice().sort(function(a, b) { return a.origDay < b.origDay ? -1 : a.origDay > b.origDay ? 1 : 0; });
            var selParts = otdSelectedPassMonth.split('-');
            var claimsLbl = MONTH_SHORT[parseInt(selParts[1], 10) - 1] + (multiYear ? ' \'' + selParts[0].slice(2) : '') + ' claims';
            claimsHtml = '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">' +
                '<div style="font-size:10px;font-weight:700;color:var(--muted2);margin-bottom:5px">' + claimsLbl + '</div>' +
                '<div>' +
                entries.map(function(e) {
                    var dp2 = e.origDay.split('-');
                    var dayLbl = dp2.length === 3 ? MONTH_SHORT[parseInt(dp2[1], 10) - 1] + ' ' + parseInt(dp2[2], 10) : e.origDay;
                    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border);font-size:11px">' +
                        '<span style="color:var(--muted2);font-family:var(--mono);font-size:10px">' + escHtml(dayLbl) + '</span>' +
                        '<span style="font-weight:700;font-family:var(--mono);color:var(--accent)">' + RAX_ICON + e.rax.toLocaleString() + '</span>' +
                    '</div>';
                }).join('') +
                '</div></div>';
        }
        return '<div style="grid-column:1/-1;background:var(--bg2);border:1px solid ' + rc + '66;border-radius:10px;padding:10px;margin:2px 0 4px">' +
            '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">' +
                '<span style="font-size:12px;font-weight:700;color:var(--fg)">' + escHtml(p.name) + '</span>' +
                '<span style="font-size:8px;font-weight:700;color:#fff;background:' + rc + ';border-radius:3px;padding:1px 5px">' + escHtml(p.levelLabel || ('L' + p.level)) + '</span>' +
                '<span style="font-size:9px;color:var(--muted2)">' + p.sport.toUpperCase() + ' · ' + escHtml(otdFormatSeason(p.sport, p.season)) + '</span>' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:repeat(' + Math.min(months.length, 4) + ',1fr);gap:4px">' + monthBtns + '</div>' +
            claimsHtml +
        '</div>';
    }

    function buildOtdPassesList() {
        var q = otdPassesSearch.toLowerCase();
        var thisYear = new Date().getFullYear();
        var items = otdPlayers
            .filter(function(p) {
                if (!q) return true;
                return p.name.toLowerCase().indexOf(q) >= 0 || p.sport.toLowerCase().indexOf(q) >= 0;
            })
            .map(function(p) {
                var total = 0;
                if (p.earnings) {
                    p.earnings.forEach(function(e) {
                        var dp = (e.day || '').split('T')[0].split('-');
                        var oy = parseInt(dp[0], 10);
                        if (oy >= thisYear && otdCalYear <= oy) return;
                        total += e.atRarityEarnings || 0;
                    });
                }
                return { p: p, total: total };
            })
            .sort(function(a, b) { return b.total - a.total; });

        if (!items.length) {
            return '<div style="text-align:center;padding:20px 0;color:var(--muted2);font-size:12px">' + (q ? 'No passes match your search' : 'No passes loaded') + '</div>';
        }

        var selectedItemIdx = -1;
        if (otdSelectedPass) {
            items.forEach(function(item, i) { if (item.p === otdSelectedPass) selectedItemIdx = i; });
        }

        var cardHtmls = items.map(function(item, i) {
            var p = item.p;
            var playerIdx = otdPlayers.indexOf(p);
            var rc = p.rarityColor || otdRarityColor(p.level);
            var av = p.avatar || '';
            var emoji = OTD_SPORT_EMOJI[p.sport] || '🎴';
            var seasonFmt = otdFormatSeason(p.sport, p.season);
            var isLoading = p.earnings === null;
            var isSelected = p === otdSelectedPass;
            var bgUrl = p.backgroundSource ? '/api/real/otd?action=card_bg&src=' + encodeURIComponent(p.backgroundSource) : '';
            var headshot = av ? 'https://media.realapp.com/assets/players/default/small/' + av + '.webp' : '';
            var eid = String(p.id || '');
            var eet = p.entityType || 'player';
            var pId = String(p.passId || '');
            var CARD_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>';

            return '<div onclick="otdSelectPass(' + playerIdx + ')" style="position:relative;border-radius:10px;overflow:hidden;height:180px;cursor:pointer;background:linear-gradient(160deg,' + rc + '55 0%,' + rc + '22 100%);border:' + (isSelected ? '2px solid ' + rc : '1px solid ' + rc + '55') + ';box-shadow:' + (isSelected ? '0 0 0 1px ' + rc + '66,0 0 12px ' + rc + '33' : 'none') + '">' +
                // Card art background (abstract pattern/art, lowest layer)
                (bgUrl ? '<img src="' + bgUrl + '" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;z-index:0" onerror="this.style.display=\'none\'">' : '') +
                // Emoji watermark when no card art
                (!bgUrl ? '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:48px;opacity:.2;z-index:0">' + emoji + '</div>' : '') +
                // Player headshot — transparent cutout; falls back to sport emoji on error
                (headshot
                    ? '<img src="' + headshot + '" style="position:absolute;top:10%;left:0;right:0;width:100%;height:52%;object-fit:contain;object-position:bottom center;z-index:1" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
                      '<div style="display:none;position:absolute;top:10%;left:0;right:0;height:52%;align-items:center;justify-content:center;font-size:40px;z-index:1">' + emoji + '</div>'
                    : '<div style="position:absolute;top:10%;left:0;right:0;height:52%;display:flex;align-items:center;justify-content:center;font-size:40px;z-index:1">' + emoji + '</div>') +
                // Dark gradient overlay for text legibility
                '<div style="position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,.05) 0%,rgba(0,0,0,.15) 40%,rgba(0,0,0,.82) 68%,rgba(0,0,0,.92) 100%);z-index:2"></div>' +
                // Top row: sport left, year right
                '<div style="position:absolute;top:6px;left:6px;right:6px;display:flex;justify-content:space-between;align-items:center;z-index:3">' +
                    '<span style="font-size:8px;font-weight:800;color:#fff;background:rgba(0,0,0,.55);padding:2px 6px;border-radius:3px;letter-spacing:.04em">' + p.sport.toUpperCase() + '</span>' +
                    '<span style="font-size:8px;font-weight:600;color:rgba(255,255,255,.9);background:rgba(0,0,0,.55);padding:2px 6px;border-radius:3px">' + escHtml(seasonFmt) + '</span>' +
                '</div>' +
                // Bottom info
                '<div style="position:absolute;bottom:0;left:0;right:0;padding:6px 7px 7px;z-index:3">' +
                    '<div style="font-size:10px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;text-shadow:0 1px 4px rgba(0,0,0,.9)">' + escHtml(p.name) + '</div>' +
                    '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:3px;gap:4px">' +
                        '<span style="font-size:8px;font-weight:700;color:#fff;background:' + rc + ';border-radius:3px;padding:1px 5px;flex-shrink:0">' + escHtml(p.levelLabel || ('L' + p.level)) + '</span>' +
                        '<span style="font-size:10px;font-weight:700;font-family:var(--mono);color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.9);flex:1;text-align:right">' + (isLoading ? '…' : RAX_ICON + item.total.toLocaleString()) + '</span>' +
                        (eid ? '<button onclick="event.stopPropagation();otdOpenCardLink(\'' + eid + '\',\'' + p.sport + '\',\'' + eet + '\',\'\',\'' + pId + '\')" title="View card on RS" style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);border-radius:4px;color:#fff;padding:2px 5px;cursor:pointer;display:flex;align-items:center;flex-shrink:0">' + CARD_SVG + '</button>' : '') +
                    '</div>' +
                '</div>' +
            '</div>';
        });

        // Splice breakdown card (spans both columns) right after the row of the selected card
        if (selectedItemIdx >= 0) {
            var insertAfter = Math.floor(selectedItemIdx / 2) * 2 + 2; // end of the row + 1
            var breakdownHtml = buildBreakdownCard(otdSelectedPass);
            if (breakdownHtml) cardHtmls.splice(Math.min(insertAfter, cardHtmls.length), 0, breakdownHtml);
        }

        return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding-bottom:6px">' + cardHtmls.join('') + '</div>';
    }

    function renderOtdPassesPanel() {
        var el = document.getElementById('otd-passes-panel-wrap');
        if (!el) return;
        el.innerHTML =
            '<div style="font-size:13px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">' +
                '<span>Passes</span>' +
                '<span style="font-size:11px;font-weight:400;color:var(--muted2)">' + otdPlayers.length + ' total</span>' +
            '</div>' +
            '<input id="otd-passes-search" type="text" placeholder="Search passes…" value="' + escHtml(otdPassesSearch) + '" autocomplete="off" ' +
                'oninput="otdPassesSearchInput(this.value)" ' +
                'style="width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:12px;padding:7px 10px;border-radius:6px;margin-bottom:10px">' +
            '<div id="otd-passes-list" style="overflow-y:auto;max-height:calc(100vh - 220px);padding-right:2px">' + buildOtdPassesList() + '</div>';
    }

    function otdRunCheck() {
        if (!otdCheckPlayer) return;
        var season = String((document.getElementById('otd-check-season') || {}).value || otdCheckPlayer.season);
        var level = parseInt((document.getElementById('otd-check-level') || {}).value || String(otdCheckPlayer.level), 10);
        var lbl = (OTD_LEVEL_OPTIONS.find(function(o) { return o.value === level; }) || {}).label || 'Level ' + level;
        otdCheckPlayer.season = season;
        otdCheckPlayer.level = level;
        otdCheckPlayer.levelLabel = lbl;
        // Find matching pass already in otdPlayers (RS account or SIM) by ID or name.
        // Search API and passes API can return different entity IDs for the same player.
        var cp2 = otdCheckPlayer;
        var rsMatchForCheck = otdPlayers.find(function(p) {
            return p.sport === cp2.sport && p.season === cp2.season &&
                (String(p.id) === String(cp2.id) || p.name.toLowerCase() === cp2.name.toLowerCase());
        });
        // If a matching pass already has earnings loaded at this exact level, use them directly.
        // Must check .length > 0 — empty array is truthy and would short-circuit to "no earnings".
        if (rsMatchForCheck && rsMatchForCheck.earnings && rsMatchForCheck.earnings.length > 0 && rsMatchForCheck.level === cp2.level) {
            otdCheckLoading = false;
            otdCheckEarnings = rsMatchForCheck.earnings;
            renderOtdCheckWrap();
            return;
        }
        var checkId = (rsMatchForCheck && rsMatchForCheck.id) ? rsMatchForCheck.id : cp2.id;
        otdCheckLoading = true;
        otdCheckEarnings = null;
        renderOtdCheckWrap();
        fetch('/api/real/otd?action=earnings&id=' + checkId + '&sport=' + cp2.sport + '&season=' + cp2.season + '&level=' + cp2.level + '&entityType=' + cp2.entityType + '&force=1', { credentials: 'same-origin' })
            .then(function(r) { return r.ok ? r.json() : r.json().catch(function() { return { ok: false, _status: r.status }; }); })
            .then(function(d) {
                console.log('[OTD Check] earnings response:', JSON.stringify(d).slice(0, 500));
                otdCheckLoading = false;
                otdCheckEarnings = (d.ok && d.earnings && d.earnings.length > 0) ? d.earnings : [];
                otdCheckDebug = d.ok ? null : (d.error || d._status || 'empty');
                renderOtdCheckWrap();
            })
            .catch(function(e) { console.error('[OTD Check] fetch error:', e); otdCheckLoading = false; otdCheckEarnings = []; otdCheckDebug = 'fetch-error'; renderOtdCheckWrap(); });
    }

    function otdAddCheckPlayer() {
        if (!otdCheckPlayer) return;
        var cp = otdCheckPlayer;
        // Read dropdown values — user may have changed them without pressing Check
        var season = String((document.getElementById('otd-check-season') || {}).value || cp.season);
        var level = parseInt((document.getElementById('otd-check-level') || {}).value || String(cp.level), 10);
        var lbl = (OTD_LEVEL_OPTIONS.find(function(o) { return o.value === level; }) || {}).label || 'Level ' + level;
        cp.season = season; cp.level = level; cp.levelLabel = lbl;
        // Same player+sport+season already present — update rarity instead of adding a duplicate.
        // Use name as fallback in case search API returns a different entity ID than the passes API.
        var existingIdx2 = -1;
        otdPlayers.forEach(function(p, i) {
            if (p.sport === cp.sport && p.season === cp.season &&
                (String(p.id) === String(cp.id) || p.name.toLowerCase() === cp.name.toLowerCase()))
                existingIdx2 = i;
        });
        if (existingIdx2 >= 0) {
            otdChangeLevel(existingIdx2, cp.level);
            renderOtdCheckWrap();
            return;
        }
        var color = OTD_COLORS[otdColorIdx % OTD_COLORS.length];
        otdColorIdx++;
        if (otdCheckEarnings !== null) {
            // Earnings already fetched — set them on the entry before pushing so numLoading never increments
            // and the loading screen never fires, even if other passes are still being loaded.
            var entry = { id: cp.id, name: cp.name, sport: cp.sport, season: cp.season, level: cp.level, levelLabel: cp.levelLabel, entityType: cp.entityType || 'player', color: color, rarityColor: otdRarityColor(cp.level), earnings: otdCheckEarnings, isAdded: true, avatar: cp.avatar || '' };
            otdPlayers.push(entry);
            renderOtdChips();
            renderOtdResults();
            renderOtdCheckWrap();
        } else {
            // No earnings yet — push with null (shows loading for this entry), then fetch
            var entry = { id: cp.id, name: cp.name, sport: cp.sport, season: cp.season, level: cp.level, levelLabel: cp.levelLabel, entityType: cp.entityType || 'player', color: color, rarityColor: otdRarityColor(cp.level), earnings: null, isAdded: true, avatar: cp.avatar || '' };
            otdPlayers.push(entry);
            renderOtdChips();
            renderOtdResults();
            renderOtdCheckWrap();
            fetch('/api/real/otd?action=earnings&id=' + cp.id + '&sport=' + cp.sport + '&season=' + cp.season + '&level=' + cp.level + '&entityType=' + (cp.entityType || 'player'), { credentials: 'same-origin' })
                .then(function(r) { return r.ok ? r.json() : { ok: false }; })
                .then(function(d) {
                    entry.earnings = (d.ok && d.earnings) ? d.earnings : [];
                    if (d.ok && d.earnings) otdCheckEarnings = d.earnings;
                    renderOtdChips();
                    renderOtdResults();
                    renderOtdCheckWrap();
                })
                .catch(function() { entry.earnings = []; renderOtdChips(); renderOtdResults(); renderOtdCheckWrap(); });
        }
    }

    function renderOtdCheckWrap() {
        var el = document.getElementById('otd-check-wrap');
        if (!el) return;
        var canShow = otdMode === 'username' && otdPlayers.length > 0 && !otdLoadingPasses;
        if (!canShow) { el.innerHTML = ''; return; }
        if (!otdCheckMode && !otdFindMode) {
            el.innerHTML = '<div style="margin-bottom:14px;display:flex;flex-wrap:wrap;gap:8px">' +
                '<button onclick="otdToggleCheck()" style="background:var(--bg3);border:1px solid var(--border2);color:var(--muted);font-family:var(--sans);font-size:12px;font-weight:600;padding:6px 14px;border-radius:6px;cursor:pointer">⊕ Check Before You Buy</button>' +
                '<button onclick="otdTogglePasses()" style="background:' + (otdPassesOpen ? 'rgba(99,102,241,.1)' : 'var(--bg3)') + ';border:1px solid ' + (otdPassesOpen ? 'var(--accent)' : 'var(--border2)') + ';color:' + (otdPassesOpen ? 'var(--accent)' : 'var(--muted)') + ';font-family:var(--sans);font-size:12px;font-weight:600;padding:6px 14px;border-radius:6px;cursor:pointer">☰ Passes</button>' +
            '</div>';
            return;
        }
        if (otdFindMode) { renderOtdFindWrap(); return; }

        var cp = otdCheckPlayer;
        var curCheckSport = (cp && cp.sport) || otdCheckSport;
        var sportOpts = OTD_SPORTS_LIST.map(function(s) {
            return '<option value="' + s.key + '"' + (s.key === curCheckSport ? ' selected' : '') + '>' + s.label + '</option>';
        }).join('');
        var curYear = new Date().getFullYear();
        var levelOpts = OTD_LEVEL_OPTIONS.map(function(o) {
            return '<option value="' + o.value + '"' + (cp && cp.level === o.value ? ' selected' : '') + '>' + escHtml(o.label) + '</option>';
        }).join('');
        var inputVal = cp ? escHtml(cp.name) : '';

        var resultsHtml = '';
        if (otdCheckLoading) {
            resultsHtml = '<div style="font-size:12px;color:var(--muted);padding:8px 0">Fetching earnings data…</div>';
        } else if (otdCheckEarnings !== null) {
            resultsHtml = renderOtdCheckResults();
        }

        var infoCard = '';
        if (cp) {
            var infoRc = otdRarityColor(cp.level);
            var infoSportLabel = (OTD_SPORTS_LIST.find(function(s) { return s.key === cp.sport; }) || {}).label || cp.sport.toUpperCase();
            var infoSeasonFmt = otdFormatSeason(cp.sport, cp.season);
            var earnTotal = 0; var earnDays = 0;
            if (otdCheckEarnings && otdCheckEarnings.length) {
                var infoThisYear = new Date().getFullYear();
                otdCheckEarnings.forEach(function(e) {
                    var dp = (e.day || '').split('T')[0].split('-');
                    if (dp.length !== 3) return;
                    var origYear = parseInt(dp[0], 10);
                    if (origYear >= infoThisYear && otdCalYear <= origYear) return;
                    earnTotal += e.atRarityEarnings || 0;
                    earnDays++;
                });
            }
            infoCard = '<div style="background:' + infoRc + '18;border:1px solid ' + infoRc + '44;border-radius:8px;padding:11px 13px;margin-bottom:10px">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">' +
                    '<div style="display:flex;align-items:center;gap:9px">' +
                        (cp.avatar ? '<img src="https://media.realapp.com/assets/players/default/small/' + cp.avatar + '.webp" style="width:34px;height:34px;border-radius:50%;object-fit:cover;border:2px solid ' + infoRc + '66" onerror="this.style.display=\'none\'">' : '') +
                        '<div>' +
                            '<div style="font-size:13px;font-weight:700;color:var(--fg)">' + escHtml(cp.name) + '</div>' +
                            '<div style="font-size:11px;color:var(--muted2);margin-top:1px">' + escHtml(infoSportLabel) + ' · ' + escHtml(infoSeasonFmt) + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<span style="font-size:10px;font-weight:700;color:#fff;background:' + infoRc + ';padding:3px 8px;border-radius:4px;white-space:nowrap">' + escHtml(cp.levelLabel || 'Level ' + cp.level) + '</span>' +
                '</div>' +
                (otdCheckEarnings !== null && !otdCheckLoading && otdCheckEarnings.length > 0 ?
                    '<div style="margin-top:9px;padding-top:8px;border-top:1px solid ' + infoRc + '33;display:flex;align-items:baseline;gap:6px">' +
                        '<span style="font-size:18px;font-weight:700;font-family:var(--mono);color:var(--accent)">' + earnTotal.toLocaleString() + '</span>' +
                        '<span style="font-size:10px;color:var(--muted2);text-transform:uppercase;letter-spacing:.4px">Rax / Year</span>' +
                    '</div>' : '') +
            '</div>';
        }

        el.innerHTML = '<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:14px;margin-bottom:14px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
                '<span style="font-size:13px;font-weight:700">Check Before You Buy</span>' +
                '<button onclick="otdToggleCheck()" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;line-height:1;padding:0">×</button>' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:' + (infoCard || resultsHtml ? '12px' : '0') + '">' +
                '<div style="position:relative;flex:1;min-width:160px">' +
                    '<input id="otd-check-input" type="text" placeholder="Search player name…" value="' + inputVal + '" autocomplete="off" ' +
                        'style="width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:13px;padding:8px 10px;border-radius:6px" ' +
                        'oninput="otdCheckSearchInput(this.value)" />' +
                    '<div id="otd-check-ac" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;z-index:200;margin-top:3px;overflow:hidden"></div>' +
                '</div>' +
                '<select id="otd-check-sport" onchange="otdCheckSportChange(this.value)" style="background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:13px;padding:8px;border-radius:6px">' + sportOpts + '</select>' +
                '<select id="otd-check-season" onchange="if(otdCheckPlayer){otdCheckPlayer.season=this.value;}" style="background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:13px;padding:8px;border-radius:6px">' + otdSeasonOpts(curCheckSport, cp && cp.season) + '</select>' +
                '<select id="otd-check-level" onchange="if(otdCheckPlayer){var lv=parseInt(this.value,10);var lb=(OTD_LEVEL_OPTIONS.find(function(o){return o.value===lv;})||{}).label||\'Level \'+lv;otdCheckPlayer.level=lv;otdCheckPlayer.levelLabel=lb;}" style="background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:13px;padding:8px;border-radius:6px">' + levelOpts + '</select>' +
                '<button onclick="otdRunCheck()" style="background:var(--accent);border:none;color:#fff;font-family:var(--sans);font-size:13px;font-weight:700;padding:8px 16px;border-radius:6px;cursor:pointer;' + (cp ? '' : 'opacity:.4;pointer-events:none;') + 'white-space:nowrap">Check</button>' +
                (function() {
                    var alreadyAdded = cp && otdPlayers.some(function(p) { return p.isAdded && p.id === cp.id && p.sport === cp.sport && p.season === cp.season; });
                    if (alreadyAdded) return '<button disabled style="background:#22c55e;border:none;color:#fff;font-family:var(--sans);font-size:13px;font-weight:700;padding:8px 16px;border-radius:6px;white-space:nowrap;opacity:.7;cursor:default">Added ✓</button>';
                    return '<button onclick="otdAddCheckPlayer()" style="background:#22c55e;border:none;color:#fff;font-family:var(--sans);font-size:13px;font-weight:700;padding:8px 16px;border-radius:6px;cursor:pointer;white-space:nowrap;' + (cp ? '' : 'opacity:.4;pointer-events:none;') + '">＋ Add</button>';
                })() +
            '</div>' +
            infoCard +
            resultsHtml +
        '</div>';
    }

    function renderOtdFindWrap() {
        var el = document.getElementById('otd-check-wrap');
        if (!el) return;
        var fp = otdFindPlayer;
        var curYear = new Date().getFullYear();
        var sportOpts = OTD_SPORTS_LIST.map(function(s) {
            return '<option value="' + s.key + '"' + (fp && fp.sport === s.key ? ' selected' : '') + '>' + s.label + '</option>';
        }).join('');

        var infoHtml = '';
        if (otdFindLoading) {
            infoHtml = '<div style="font-size:12px;color:var(--muted);padding:8px 0">Fetching earnings…</div>';
        } else if (fp && otdFindEarnings !== null) {
            infoHtml = renderOtdFindMoreInfo();
        }

        el.innerHTML = '<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:14px;margin-bottom:14px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
                '<span style="font-size:13px;font-weight:700">🔍 Find Player</span>' +
                '<button onclick="otdToggleFind()" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;line-height:1;padding:0">×</button>' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">' +
                '<div style="position:relative;flex:1;min-width:160px">' +
                    '<input id="otd-find-input" type="text" placeholder="Search player name…" value="' + (fp ? escHtml(fp.name) : '') + '" autocomplete="off" ' +
                        'style="width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:13px;padding:8px 10px;border-radius:6px" ' +
                        'oninput="otdFindSearchInput(this.value)" />' +
                    '<div id="otd-find-ac" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;z-index:200;margin-top:3px;overflow:hidden"></div>' +
                '</div>' +
                '<select id="otd-find-sport" onchange="if(otdFindPlayer){otdFindPlayer.sport=this.value;otdFindEarnings=null;renderOtdCheckWrap();}var fi=document.getElementById(\'otd-find-input\');if(fi&&fi.value&&fi.value.length>=2)otdFindSearchInput(fi.value);" style="background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:13px;padding:8px;border-radius:6px">' + sportOpts + '</select>' +
                '<select id="otd-find-season" onchange="if(otdFindPlayer){otdFindPlayer.season=this.value;}" style="background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:13px;padding:8px;border-radius:6px">' + otdSeasonOpts(fp && fp.sport || 'mlb', fp && fp.season) + '</select>' +
                '<button onclick="otdRunFind()" style="background:#f59e0b;border:none;color:#000;font-family:var(--sans);font-size:13px;font-weight:700;padding:8px 16px;border-radius:6px;cursor:pointer;' + (fp ? '' : 'opacity:.4;pointer-events:none;') + 'white-space:nowrap">More Info</button>' +
            '</div>' +
            (infoHtml ? '<div style="margin-top:10px">' + infoHtml + '</div>' : '') +
        '</div>';
    }

    function renderOtdFindMoreInfo() {
        var fp = otdFindPlayer;
        if (!fp || !otdFindEarnings) return '';
        var MONTH_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        var MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var thisYear = new Date().getFullYear();

        var monthMap = {};
        var totalRax = 0; var totalDays = 0;
        otdFindEarnings.forEach(function(e) {
            var dp = (e.day || '').split('T')[0].split('-');
            if (dp.length !== 3) return;
            var origYear = parseInt(dp[0], 10);
            if (origYear >= thisYear && otdCalYear <= origYear) return;
            var m = parseInt(dp[1], 10) - 1;
            var d = parseInt(dp[2], 10);
            var rax = e.atRarityEarnings || 0;
            if (!monthMap[m]) monthMap[m] = [];
            monthMap[m].push({ d: d, rax: rax });
            totalRax += rax; totalDays++;
        });

        var months = Object.keys(monthMap).map(Number).sort(function(a, b) { return a - b; });
        if (!months.length) {
            var yr = parseInt(fp.season, 10);
            if (yr >= thisYear) {
                return '<div style="font-size:12px;color:var(--muted2);line-height:1.5">' +
                    '<strong style="color:var(--fg)">' + yr + ' card — OTD starts in ' + (yr + 1) + '.</strong><br>' +
                    'Games from the current season aren\'t claimable as OTD until the following year. Switch the calendar to ' + (yr + 1) + ' to see earning dates.' +
                '</div>';
            }
            return '<div style="font-size:12px;color:var(--muted)">No earning days found for this player/season.</div>';
        }

        var rc = otdRarityColor(fp.level);
        var levelOpts = OTD_LEVEL_OPTIONS.map(function(o) {
            return '<option value="' + o.value + '"' + (o.value === fp.level ? ' selected' : '') + '>' + escHtml(o.label) + '</option>';
        }).join('');

        var rows = months.map(function(m) {
            var entries = monthMap[m].slice().sort(function(a, b) { return a.d - b.d; });
            var mTotal = entries.reduce(function(s, e) { return s + e.rax; }, 0);
            var isExpanded = !!otdFindExpandedMonths[m];
            var datesHtml = isExpanded ?
                '<div style="padding:6px 12px 8px;display:flex;flex-wrap:wrap;gap:4px;background:var(--bg3)">' +
                entries.map(function(e) {
                    return '<span style="white-space:nowrap;font-size:11px;padding:2px 6px;background:var(--bg2);border:1px solid var(--border);border-radius:4px">' +
                        MONTH_SHORT[m] + ' ' + e.d +
                        ' <span style="font-family:var(--mono);color:var(--accent);font-weight:600">' + e.rax.toLocaleString() + '</span>' +
                    '</span>';
                }).join('') +
                '</div>' : '';
            return '<div>' +
                '<div onclick="otdFindToggleMonth(' + m + ')" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);user-select:none;transition:background .1s" onmouseenter="this.style.background=\'var(--bg3)\'" onmouseleave="this.style.background=\'\'">' +
                    '<div style="display:flex;align-items:center;gap:8px">' +
                        '<span style="font-size:9px;color:var(--muted2)">' + (isExpanded ? '▼' : '▶') + '</span>' +
                        '<span style="font-size:12px;font-weight:700;color:var(--fg);min-width:70px">' + MONTH_FULL[m] + '</span>' +
                        '<span style="font-size:10px;color:var(--muted2)">' + entries.length + ' game' + (entries.length !== 1 ? 's' : '') + '</span>' +
                    '</div>' +
                    '<span style="font-size:11px;font-family:var(--mono);font-weight:700;color:var(--accent)">' + mTotal.toLocaleString() + ' Rax</span>' +
                '</div>' +
                datesHtml +
            '</div>';
        }).join('');

        return '<div style="border:1px solid var(--border2);border-radius:6px;overflow:hidden">' +
            '<div style="padding:7px 12px;background:var(--bg3);border-bottom:1px solid var(--border2);display:flex;justify-content:space-between;align-items:center;gap:8px">' +
                '<span style="font-size:11px;font-weight:700;color:var(--fg)">' + escHtml(fp.name) + ' · ' + fp.sport.toUpperCase() + ' ' + escHtml(otdFormatSeason(fp.sport, fp.season)) + '</span>' +
                '<select onchange="otdFindChangeRarity(parseInt(this.value,10))" style="background:' + rc + ';border:none;color:#fff;font-family:var(--sans);font-size:10px;font-weight:700;padding:2px 4px;border-radius:3px;cursor:pointer;outline:none">' + levelOpts + '</select>' +
            '</div>' +
            '<div style="max-height:320px;overflow-y:auto">' + rows + '</div>' +
            '<div style="padding:7px 12px;background:var(--bg3);border-top:1px solid var(--border2);display:flex;justify-content:space-between;align-items:center">' +
                '<span style="font-size:11px;color:var(--muted2)">★ ' + totalDays + ' earning day' + (totalDays !== 1 ? 's' : '') + ' highlighted on calendar</span>' +
                '<span style="font-size:12px;font-family:var(--mono);font-weight:700;color:var(--accent)">' + RAX_ICON + totalRax.toLocaleString() + ' total</span>' +
            '</div>' +
        '</div>';
    }

    function renderOtdCheckResults() {
        if (!otdCheckEarnings.length) {
            return '<div style="font-size:12px;color:var(--muted);padding:6px 0">No earnings found for this player/season/level.' + (otdCheckDebug ? ' [debug: ' + otdCheckDebug + ']' : '') + '</div>';
        }
        var thisYear = new Date().getFullYear();
        var sport = otdCheckPlayer.sport;
        var limit = otdClaimsView;
        var MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var totalDays = 0;
        var overlapDays = [];
        var wastedCount = 0;

        otdCheckEarnings.forEach(function(e) {
            var dp = (e.day || '').split('T')[0].split('-');
            if (dp.length !== 3) return;
            var origYear = parseInt(dp[0], 10);
            if (origYear >= thisYear && otdCalYear <= origYear) return;
            var dayKey = String(otdCalYear) + '-' + dp[1].padStart(2,'0') + '-' + dp[2].padStart(2,'0');
            totalDays++;
            // Exclude the check player itself from existing entries — same card can't conflict with itself.
            // Uses both ID and name comparison since search/passes APIs may return different entity IDs.
            var checkCp = otdCheckPlayer;
            var existingEntries = (otdDateMap[dayKey] || []).filter(function(entry) {
                if (entry.player.sport !== sport) return false;
                if (!checkCp || entry.player.season !== checkCp.season) return true;
                if (String(entry.player.id) === String(checkCp.id)) return false;
                if (entry.player.name.toLowerCase() === checkCp.name.toLowerCase()) return false;
                return true;
            });
            if (existingEntries.length > 0) {
                var newRax = e.atRarityEarnings || 0;
                var newTotal = existingEntries.length + 1;
                var isOver = newTotal > limit;
                var wasted = false;
                if (isOver) {
                    // Build sorted combined list to find highest-earning wasted card
                    var combined = existingEntries.map(function(ent) { return ent.rax || 0; });
                    combined.push(newRax);
                    combined.sort(function(a, b) { return b - a; });
                    // Only a real conflict if the best wasted card earns > 199 Rax
                    wasted = combined[limit] > 199;
                }
                if (wasted) wastedCount++;
                if (isOver) overlapDays.push({ day: dayKey, entries: existingEntries, total: newTotal, wasted: wasted, newRax: newRax });
            }
        });

        overlapDays.sort(function(a, b) { return a.day < b.day ? -1 : 1; });

        var realConflicts = overlapDays.filter(function(d) { return d.wasted; });
        var summaryColor = wastedCount > 0 ? '#ef5350' : '#22c55e';
        var summaryText = wastedCount > 0
            ? wastedCount + ' day' + (wastedCount > 1 ? 's' : '') + ' with a wasted claim over 199 Rax'
            : 'No significant conflicts — safe to buy (' + totalDays + ' earning days)';

        var html = '<div style="border-top:1px solid var(--border2);padding-top:10px">' +
            '<div style="font-size:12px;font-weight:700;color:' + summaryColor + ';margin-bottom:4px">' + summaryText + '</div>' +
            '<div style="font-size:11px;color:var(--muted2);margin-bottom:10px">' +
                escHtml(otdCheckPlayer.name) + ' · ' + sport.toUpperCase() + ' ' + otdFormatSeason(sport, otdCheckPlayer.season) + ' ' + escHtml(otdCheckPlayer.levelLabel) +
                ' · ' + totalDays + ' earning days this year · claim limit: ' + limit + '/sport/day' +
            '</div>';

        if (realConflicts.length > 0) {
            html += '<div style="display:flex;flex-direction:column;gap:8px;max-height:300px;overflow-y:auto">';
            realConflicts.forEach(function(d) {
                var parts = d.day.split('-');
                var monthDay = parts.length === 3 ? (MONTH_NAMES[parseInt(parts[1], 10) - 1] + ' ' + parseInt(parts[2], 10)) : d.day;
                // Build combined sorted list: existing entries + new card, sorted by Rax desc
                var allCards = d.entries.map(function(ent) {
                    return { name: ent.player.name, rax: ent.rax || 0, level: ent.player.levelLabel || '', isNew: false };
                });
                allCards.push({ name: otdCheckPlayer.name, rax: d.newRax || 0, level: otdCheckPlayer.levelLabel || '', isNew: true });
                allCards.sort(function(a, b) { return b.rax - a.rax; });
                var cardRows = allCards.map(function(c, idx) {
                    var claimed = idx < limit;
                    var color = claimed ? '#22c55e' : '#ef5350';
                    var nameStr = escHtml(c.name) + (c.isNew ? ' <span style="background:#4f6ef7;color:#fff;font-size:9px;font-weight:700;padding:1px 4px;border-radius:3px;vertical-align:middle">NEW</span>' : '');
                    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid var(--border2)">' +
                        '<span style="color:' + color + ';font-weight:' + (c.isNew ? '700' : '500') + '">' + nameStr + '</span>' +
                        '<span style="font-family:var(--mono);color:' + color + '">' + (c.rax || 0).toLocaleString() + '</span>' +
                    '</div>';
                }).join('');
                html += '<div style="background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:12px">' +
                    '<div style="font-weight:700;color:var(--muted2);font-size:10px;letter-spacing:.06em;margin-bottom:6px">' + monthDay.toUpperCase() + '</div>' +
                    cardRows +
                '</div>';
            });
            html += '</div>';
        }

        return html + '</div>';
    }

    function showOtdTab() {
        document.getElementById('sport-tabs').style.display = 'none';
        document.getElementById('feature-tabs').style.display = 'none';
        document.querySelector('.controls').style.display = 'none';
        document.querySelector('.status-bar').style.display = 'none';
        document.querySelector('.table-wrap').style.display = 'none';
        document.getElementById('mobile-cards').style.display = 'none';
        document.getElementById('collapse-btn').style.display = 'none';
        document.getElementById('refresh-btn').style.display = 'none';
        if (currentLoadAbort) { currentLoadAbort.abort(); currentLoadAbort = null; }
        if (nbaPoller)  { clearInterval(nbaPoller);  nbaPoller  = null; }
        if (wnbaPoller) { clearInterval(wnbaPoller); wnbaPoller = null; }
        if (mlbPoller)  { clearInterval(mlbPoller);  mlbPoller  = null; }
        if (nhlPoller)  { clearInterval(nhlPoller);  nhlPoller  = null; }
        if (dkPoller)   { clearInterval(dkPoller);   dkPoller   = null; }
        if (fcPoller)   { clearInterval(fcPoller);   fcPoller   = null; }
        document.getElementById('otd-panel').classList.add('visible');
        otdVisible = true;
        renderOtdPanel();
    }

    function hideOtdTab() {
        document.getElementById('sport-tabs').style.display = '';
        document.getElementById('feature-tabs').style.display = '';
        document.querySelector('.controls').style.display = '';
        document.querySelector('.status-bar').style.display = '';
        document.querySelector('.table-wrap').style.display = '';
        document.getElementById('mobile-cards').style.display = '';
        document.getElementById('collapse-btn').style.display = 'none';
        document.getElementById('refresh-btn').style.display = '';
        document.getElementById('otd-panel').classList.remove('visible');
        otdVisible = false;
    }

    function renderOtdPanel() {
        var panel = document.getElementById('otd-panel');
        if (!panel) return;

        var sportOpts = OTD_SPORTS_LIST.map(function(s) {
            return '<option value="' + s.key + '">' + s.label + '</option>';
        }).join('');
        var levelOpts = OTD_LEVEL_OPTIONS.map(function(o) {
            return '<option value="' + o.value + '"' + (o.value === 4 ? ' selected' : '') + '>' + escHtml(o.label) + '</option>';
        }).join('');
        var curYear = new Date().getFullYear();

        var isUserMode = otdMode === 'username';
        var tabStyle = function(active) {
            return 'font-size:12px;font-weight:700;padding:6px 14px;border-radius:5px;cursor:pointer;border:1px solid ' +
                (active ? 'var(--accent);background:rgba(99,102,241,.12);color:var(--accent)' : 'var(--border2);background:transparent;color:var(--muted)') +
                ';font-family:var(--sans)';
        };

        panel.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">' +
                '<div style="font-size:16px;font-weight:800;letter-spacing:.04em">🗓️ On This Day</div>' +
                '<div style="display:flex;gap:6px">' +
                    '<button onclick="document.getElementById(\'otd-tab-btn\').click()" style="background:var(--bg3);border:1px solid var(--border2);color:var(--muted);font-family:var(--sans);font-size:12px;font-weight:600;padding:7px 14px;border-radius:6px;cursor:pointer">&larr; Back</button>' +
                '</div>' +
            '</div>' +
            // Mode toggle
            '<div style="display:flex;gap:6px;margin-bottom:14px">' +
                '<button style="' + tabStyle(!isUserMode) + '" onclick="otdSetMode(\'player\')">Search Player</button>' +
                '<button style="' + tabStyle(isUserMode) + '" onclick="otdSetMode(\'username\')">By Username</button>' +
            '</div>' +
            // Player search row
            (!isUserMode ?
                '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:14px">' +
                    '<div style="position:relative;flex:1;min-width:160px">' +
                        '<input id="otd-search-input" type="text" placeholder="Search player name…" autocomplete="off" ' +
                            'style="width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:13px;padding:8px 10px;border-radius:6px" ' +
                            'oninput="otdOnSearchInput(this.value)" />' +
                        '<div id="otd-autocomplete" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;z-index:200;margin-top:3px;overflow:hidden"></div>' +
                    '</div>' +
                    '<select id="otd-sport-sel" onchange="otdUpdateSeasonOpts(this.value)" style="background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:13px;padding:8px 8px;border-radius:6px">' + sportOpts + '</select>' +
                    '<select id="otd-season-sel" style="background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:13px;padding:8px 8px;border-radius:6px">' + otdSeasonOpts('mlb', curYear) + '</select>' +
                    '<select id="otd-level-sel" style="background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:13px;padding:8px 8px;border-radius:6px">' + levelOpts + '</select>' +
                    '<button onclick="otdAddPlayer()" style="background:var(--accent);border:none;color:#fff;font-family:var(--sans);font-size:13px;font-weight:700;padding:8px 16px;border-radius:6px;cursor:pointer;white-space:nowrap">+ Add</button>' +
                '</div>'
            :
                // Username search row — seasons scanned automatically (2022–current)
                '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:14px">' +
                    '<div style="position:relative;flex:1;min-width:180px">' +
                        '<input id="otd-user-input" type="text" placeholder="RS username…" autocomplete="off" ' +
                            'style="width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--sans);font-size:13px;padding:8px 10px;border-radius:6px" ' +
                            'oninput="otdOnUserInput(this.value)" />' +
                        '<div id="otd-user-autocomplete" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;z-index:200;margin-top:3px;overflow:hidden"></div>' +
                    '</div>' +
                    '<button onclick="otdLoadUserPasses()" style="background:var(--accent);border:none;color:#fff;font-family:var(--sans);font-size:13px;font-weight:700;padding:8px 16px;border-radius:6px;cursor:pointer;white-space:nowrap">' + (otdLoadingPasses ? 'Loading…' : 'Load Passes') + '</button>' +
                '</div>'
            ) +
            '<div id="otd-search-err" style="display:none;font-size:12px;color:#ef5350;margin-bottom:8px"></div>' +
            '<div id="otd-chips" style="margin-bottom:16px"></div>' +
            '<div id="otd-check-wrap"></div>' +
            '<div id="otd-results"></div>';

        renderOtdChips();
        renderOtdCheckWrap();
        renderOtdResults();
    }

    function otdOnSearchInput(val) {
        clearTimeout(otdSearchTimer);
        var ac = document.getElementById('otd-autocomplete');
        if (!ac) return;
        if (!val || val.length < 2) { ac.style.display = 'none'; otdSelectedPlayer = null; return; }
        otdSearchTimer = setTimeout(function() {
            var sport = (document.getElementById('otd-sport-sel') || {}).value || 'mlb';
            fetch('/api/real/otd?action=search&q=' + encodeURIComponent(val) + '&sport=' + sport, { credentials: 'same-origin' })
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    ac = document.getElementById('otd-autocomplete');
                    if (!ac) return;
                    if (!d.ok || !d.players || !d.players.length) { ac.style.display = 'none'; return; }
                    ac.innerHTML = '';
                    d.players.forEach(function(p) {
                        var row = document.createElement('div');
                        row.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border)';
                        row.textContent = p.name + ' (' + p.sport.toUpperCase() + ')';
                        row.onmousedown = function(e) { e.preventDefault(); };
                        row.onclick = function() {
                            otdSelectedPlayer = p;
                            var inp = document.getElementById('otd-search-input');
                            if (inp) inp.value = p.name;
                            ac.style.display = 'none';
                        };
                        row.onmouseover = function() { this.style.background = 'var(--bg3)'; };
                        row.onmouseout  = function() { this.style.background = ''; };
                        ac.appendChild(row);
                    });
                    ac.style.display = '';
                })
                .catch(function() { if (ac) ac.style.display = 'none'; });
        }, 400);
    }

    function otdAddPlayer() {
        if (!otdSelectedPlayer) {
            var inp = document.getElementById('otd-search-input');
            if (inp) { inp.style.borderColor = 'var(--red,#ef5350)'; setTimeout(function() { if (inp) inp.style.borderColor = ''; }, 2000); }
            var errEl = document.getElementById('otd-search-err');
            if (errEl) { errEl.textContent = 'Search and select a player from the dropdown first'; errEl.style.display = ''; setTimeout(function() { if (errEl) errEl.style.display = 'none'; }, 3000); }
            return;
        }
        var sport  = (document.getElementById('otd-sport-sel') || {}).value || otdSelectedPlayer.sport;
        var season = (document.getElementById('otd-season-sel') || {}).value || String(new Date().getFullYear());
        var level  = parseInt((document.getElementById('otd-level-sel') || {}).value || '4', 10);
        var lbl    = (OTD_LEVEL_OPTIONS.find(function(o) { return o.value === level; }) || {}).label || 'Level ' + level;

        var existingIdx = -1;
        otdPlayers.forEach(function(p, i) { if (String(p.id) === String(otdSelectedPlayer.id) && p.sport === sport && p.season === season) existingIdx = i; });
        if (existingIdx >= 0) {
            // Same player+sport+season — update rarity instead of adding a duplicate
            var inpClear = document.getElementById('otd-search-input');
            if (inpClear) inpClear.value = '';
            var acClear = document.getElementById('otd-autocomplete');
            if (acClear) acClear.style.display = 'none';
            otdSelectedPlayer = null;
            otdChangeLevel(existingIdx, level);
            return;
        }

        var color  = OTD_COLORS[otdColorIdx % OTD_COLORS.length];
        otdColorIdx++;
        var entry  = { id: otdSelectedPlayer.id, name: otdSelectedPlayer.name, sport: sport, season: season, level: level, levelLabel: lbl, color: color, earnings: null, avatar: otdSelectedPlayer.avatar || '' };
        otdPlayers.push(entry);

        // Clear search
        var inp = document.getElementById('otd-search-input');
        if (inp) inp.value = '';
        otdSelectedPlayer = null;
        var ac = document.getElementById('otd-autocomplete');
        if (ac) ac.style.display = 'none';

        renderOtdChips();
        renderOtdResults();

        // Fetch earnings in background
        fetch('/api/real/otd?action=earnings&id=' + entry.id + '&sport=' + sport + '&season=' + season + '&level=' + level, { credentials: 'same-origin' })
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (d.ok) {
                    entry.earnings = d.earnings;
                    // First player loaded: jump calendar to nearest upcoming claim (normalize to current year)
                    var loadedCount = otdPlayers.filter(function(p) { return p.earnings && p.earnings.length; }).length;
                    if (loadedCount === 1 && d.earnings && d.earnings.length) {
                        var curYr = new Date().getFullYear();
                        var todayStr = new Date().toISOString().slice(0, 10);
                        var sorted = d.earnings.map(function(e) {
                            var dp2 = (e.day || '').split('T')[0].split('-');
                            return dp2.length === 3 ? (curYr + '-' + dp2[1].padStart(2,'0') + '-' + dp2[2].padStart(2,'0')) : '';
                        }).filter(Boolean).sort();
                        var upcoming = sorted.filter(function(x) { return x >= todayStr; });
                        var target = upcoming[0] || sorted[sorted.length - 1];
                        if (target) {
                            var tp = target.split('-');
                            if (tp.length === 3) { otdCalYear = parseInt(tp[0], 10); otdCalMonth = parseInt(tp[1], 10) - 1; }
                        }
                    }
                    renderOtdResults();
                }
            })
            .catch(function() {});
    }

    function otdRemovePlayer(idx) {
        otdPlayers.splice(idx, 1);
        renderOtdChips();
        renderOtdResults();
    }

    function otdSetMode(mode) {
        otdMode = mode;
        otdPlayers = [];
        otdColorIdx = 0;
        otdSelectedPlayer = null;
        otdSelectedUser = null;
        otdLoadingPasses = false;
        renderOtdPanel();
    }

    function otdOnUserInput(val) {
        clearTimeout(otdUserSearchTimer);
        var ac = document.getElementById('otd-user-autocomplete');
        if (!ac) return;
        if (!val || val.length < 2) { ac.style.display = 'none'; otdSelectedUser = null; return; }
        otdUserSearchTimer = setTimeout(function() {
            fetch('/api/real/otd?action=search_users&q=' + encodeURIComponent(val), { credentials: 'same-origin' })
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    ac = document.getElementById('otd-user-autocomplete');
                    if (!ac) return;
                    if (!d.ok || !d.users || !d.users.length) { ac.style.display = 'none'; return; }
                    ac.innerHTML = '';
                    d.users.forEach(function(u) {
                        var row = document.createElement('div');
                        row.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border)';
                        row.textContent = u.username + (u.displayName && u.displayName !== u.username ? '  (' + u.displayName + ')' : '');
                        row.onmousedown = function(e) { e.preventDefault(); };
                        row.onclick = function() {
                            otdSelectedUser = u;
                            var inp = document.getElementById('otd-user-input');
                            if (inp) inp.value = u.username;
                            ac.style.display = 'none';
                        };
                        row.onmouseover = function() { this.style.background = 'var(--bg3)'; };
                        row.onmouseout  = function() { this.style.background = ''; };
                        ac.appendChild(row);
                    });
                    ac.style.display = '';
                })
                .catch(function() { var ac = document.getElementById('otd-user-autocomplete'); if (ac) ac.style.display = 'none'; });
        }, 400);
    }

    var OTD_SPORTS = ['mlb', 'nba', 'wnba', 'nhl', 'nfl', 'soccer', 'ufc', 'mma', 'cbb', 'cfb', 'golf'];
    var OTD_SCAN_SEASONS = (function() {
        var y = new Date().getFullYear(); return [y, y-1, y-2, y-3, y-4];
    })();

    function otdLoadUserPasses() {
        var errEl = document.getElementById('otd-search-err');
        if (!otdSelectedUser) {
            if (errEl) { errEl.textContent = 'Search and select an RS username first'; errEl.style.display = ''; setTimeout(function() { if (errEl) errEl.style.display = 'none'; }, 3000); }
            var inp = document.getElementById('otd-user-input');
            if (inp) { inp.style.borderColor = 'var(--red,#ef5350)'; setTimeout(function() { if (inp) inp.style.borderColor = ''; }, 2000); }
            return;
        }
        if (otdLoadingPasses) return;

        otdPlayers = [];
        otdColorIdx = 0;
        otdLoadingPasses = true;
        renderOtdPanel();

        var userId = otdSelectedUser.id;

        // Single consolidated fetch — backend batches all sports×seasons to avoid RS rate limiting
        fetch('/api/real/otd?action=user_passes_all&userId=' + encodeURIComponent(userId), { credentials: 'same-origin' })
            .then(function(r) { return r.json(); })
            .then(function(d) {
                otdLoadingPasses = false;
                var btn = document.querySelector('[onclick="otdLoadUserPasses()"]');
                if (btn) btn.textContent = 'Load Passes';

                if (!d.ok || !d.passes || !d.passes.length) {
                    var errEl2 = document.getElementById('otd-search-err');
                    if (errEl2) { errEl2.textContent = 'No Rare+ passes found for ' + otdSelectedUser.username; errEl2.style.display = ''; setTimeout(function() { if (errEl2) errEl2.style.display = 'none'; }, 4000); }
                    renderOtdChips();
                    renderOtdResults();
                    return;
                }

                // Build entry objects first, then batch-fetch earnings to avoid RS 429 rate limits.
                // D1 caches each (player, sport, season, level) for 12h — only cold loads hit RS.
                var earningsQueue = [];
                d.passes.forEach(function(pass) {
                    var lbl = (OTD_LEVEL_OPTIONS.find(function(o) { return o.value === pass.level; }) || {}).label || 'Level ' + pass.level;
                    var color = OTD_COLORS[otdColorIdx % OTD_COLORS.length];
                    otdColorIdx++;
                    var entry = { id: pass.playerId, name: pass.playerName || ('Player ' + pass.playerId), sport: pass.sport, season: String(pass.season), level: pass.level, levelLabel: lbl, color: color, earnings: null, entityType: pass.entityType || 'player', passId: pass.passId || null, avatar: pass.entityAvatar || pass.avatar || '', backgroundSource: pass.backgroundSource || null, rarityColor: pass.rarityColor || null, serialNumber: pass.serialNumber || null, multiplier: pass.multiplier || null };
                    otdPlayers.push(entry);
                    earningsQueue.push(entry);
                });

                renderOtdChips();
                renderOtdResults();

                // Fetch earnings in batches of 6 with 400ms between batches
                var BATCH_SIZE = 6;
                var calJumped = false;
                function fetchEarningsBatch() {
                    var batch = earningsQueue.splice(0, BATCH_SIZE);
                    if (!batch.length) return;
                    batch.forEach(function(entry) {
                        fetch('/api/real/otd?action=earnings&id=' + entry.id + '&sport=' + entry.sport + '&season=' + entry.season + '&level=' + entry.level + '&entityType=' + entry.entityType, { credentials: 'same-origin' })
                            .then(function(r) { return r.ok ? r.json() : { ok: false }; })
                            .then(function(ed) {
                                if (ed.ok && ed.earnings) {
                                    entry.earnings = ed.earnings;
                                    if (!calJumped && ed.earnings.length) {
                                        calJumped = true;
                                        var curYr2 = new Date().getFullYear();
                                        var todayStr2 = new Date().toISOString().slice(0, 10);
                                        var sorted2 = ed.earnings.map(function(e) {
                                            var dp2 = (e.day || '').split('T')[0].split('-');
                                            return dp2.length === 3 ? (curYr2 + '-' + dp2[1].padStart(2,'0') + '-' + dp2[2].padStart(2,'0')) : '';
                                        }).filter(Boolean).sort();
                                        var upcoming2 = sorted2.filter(function(x) { return x >= todayStr2; });
                                        var target2 = upcoming2[0] || sorted2[sorted2.length - 1];
                                        if (target2) { var tp2 = target2.split('-'); if (tp2.length === 3) { otdCalYear = parseInt(tp2[0], 10); otdCalMonth = parseInt(tp2[1], 10) - 1; } }
                                    }
                                } else {
                                    entry.earnings = [];
                                }
                                renderOtdChips();
                                renderOtdResults();
                            })
                            .catch(function() { entry.earnings = []; renderOtdChips(); renderOtdResults(); });
                    });
                    if (earningsQueue.length > 0) setTimeout(fetchEarningsBatch, 400);
                }
                fetchEarningsBatch();
            })
            .catch(function() {
                otdLoadingPasses = false;
                var btn = document.querySelector('[onclick="otdLoadUserPasses()"]');
                if (btn) btn.textContent = 'Load Passes';
                renderOtdChips();
                renderOtdResults();
            });
    }

    var OTD_SPORT_EMOJI = {mlb:'⚾',nba:'🏀',nhl:'🏒',nfl:'🏈',wnba:'🏀',golf:'⛳',ufc:'🥊',ncaaf:'🏈',ncaabb:'🏀',ncaam:'🏀',epl:'⚽',ucl:'⚽',mls:'⚽',fifa:'⚽',soccer:'⚽',fc:'⚽'};
    function otdRarityColor(level) {
        if (level <= 0)  return '#78909c'; // General — gray
        if (level === 1) return '#2196f3'; // Common — blue
        if (level === 2) return '#43a047'; // Uncommon — green
        if (level === 3) return '#f57c00'; // Rare — orange
        if (level === 4) return '#e53935'; // Epic — red
        if (level <= 9)  return '#8e24aa'; // Legendary — purple
        if (level <= 19) return '#d4a800'; // Mystic — yellow
        return '#e91e8c';                  // Iconic — pink
    }

    function renderOtdChips() {
        var el = document.getElementById('otd-chips');
        if (!el) return;

        var players = (otdMode === 'username')
            ? otdPlayers.filter(function(p) { return p.isAdded; })
            : otdPlayers;

        if (!players.length) {
            el.innerHTML = '<span style="font-size:12px;color:var(--muted2)">No players added yet. Search and add players above.</span>';
            return;
        }

        el.innerHTML = '<div class="otd-card-grid">' + players.map(function(p) {
            var idx = otdPlayers.indexOf(p);
            var sport = p.sport || 'mlb';
            var emoji = OTD_SPORT_EMOJI[sport] || '🎴';
            var rc = p.rarityColor || otdRarityColor(p.level);
            var av = p.avatar || '';
            var bgUrl = p.backgroundSource ? '/api/real/otd?action=card_bg&src=' + encodeURIComponent(p.backgroundSource) : '';
            var borderCol = p.rarityColor || p.color;
            var levelSel = '<select onchange="otdChangeLevel(' + idx + ',parseInt(this.value,10))" onclick="event.stopPropagation()" ' +
                'style="background:transparent;border:none;color:' + rc + ';font-size:10px;font-weight:700;cursor:pointer;max-width:100%;font-family:var(--sans);text-align:center">' +
                OTD_LEVEL_OPTIONS.map(function(o) {
                    return '<option value="' + o.value + '"' + (o.value === p.level ? ' selected' : '') + '>' + escHtml(o.label) + '</option>';
                }).join('') +
                '</select>';
            if (p.isAdded) {
                var simBg = bgUrl
                    ? 'background-image:url(' + bgUrl + ');background-size:cover;background-position:top center;'
                    : 'background:linear-gradient(160deg,' + rc + '22 0%,' + rc + '08 100%);';
                return '<div class="otd-player-card" style="' + simBg + 'border-color:' + rc + '66;padding:0;overflow:hidden">' +
                    (bgUrl ? '<div class="otd-card-bg-overlay"></div>' : '') +
                    '<div style="position:relative;display:flex;align-items:center;justify-content:center;background:rgba(79,110,247,.82);padding:5px 8px;min-height:24px">' +
                        '<button onclick="otdRemovePlayer(' + idx + ')" style="position:absolute;left:6px;top:50%;transform:translateY(-50%);background:none;border:none;color:rgba(255,255,255,.85);font-size:16px;line-height:1;cursor:pointer;padding:0;font-family:var(--sans)">×</button>' +
                        '<span style="font-size:8px;font-weight:800;color:#fff;letter-spacing:.08em">SIM</span>' +
                    '</div>' +
                    '<div style="display:flex;justify-content:center;padding:8px 4px 4px;position:relative;z-index:1">' +
                        (av
                            ? '<img src="https://media.realapp.com/assets/players/default/small/' + av + '.webp" style="width:72px;height:72px;object-fit:cover;object-position:top center;border-radius:4px" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
                              '<div style="display:none;width:72px;height:72px;border-radius:4px;background:' + rc + '22;align-items:center;justify-content:center;font-size:28px">' + emoji + '</div>'
                            : '<div style="display:flex;width:72px;height:72px;border-radius:4px;background:' + rc + '22;align-items:center;justify-content:center;font-size:28px">' + emoji + '</div>') +
                    '</div>' +
                    '<div style="padding:0 8px 8px;position:relative;z-index:1">' +
                        '<div class="otd-card-name">' + escHtml(p.name) + '</div>' +
                        '<div class="otd-card-sport">' + sport.toUpperCase() + ' · ' + escHtml(otdFormatSeason(sport, p.season)) + '</div>' +
                        '<div class="otd-card-level" style="margin-top:4px;border-color:' + rc + '55;background:' + rc + '15">' + levelSel + '</div>' +
                    '</div>' +
                '</div>';
            }
            var photoHtml = '<div style="display:flex;justify-content:center;margin-bottom:8px">' +
                (av
                    ? '<img src="https://media.realapp.com/assets/players/default/small/' + av + '.webp" ' +
                      'style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid ' + borderCol + '" ' +
                      'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
                      '<div style="display:none;width:64px;height:64px;border-radius:50%;background:' + borderCol + '22;border:2px solid ' + borderCol + ';align-items:center;justify-content:center;font-size:26px">' + emoji + '</div>'
                    : '<div style="display:flex;width:64px;height:64px;border-radius:50%;background:' + borderCol + '22;border:2px solid ' + borderCol + ';align-items:center;justify-content:center;font-size:26px">' + emoji + '</div>') +
                '</div>';
            var serialHtml = p.serialNumber ? '<div style="font-size:9px;color:var(--muted);font-family:var(--mono);margin-top:1px">#' + p.serialNumber + '</div>' : '';
            var bgStyle = 'background-color:' + borderCol + '11;' + (bgUrl ? 'background-image:url(' + bgUrl + ');background-size:cover;background-position:center;' : '');
            return '<div class="otd-player-card" style="' + bgStyle + 'border-color:' + borderCol + '88">' +
                (bgUrl ? '<div class="otd-card-bg-overlay"></div>' : '') +
                '<button onclick="otdRemovePlayer(' + idx + ')" class="otd-card-rm">×</button>' +
                photoHtml +
                '<div class="otd-card-name">' + escHtml(p.name) + '</div>' +
                '<div class="otd-card-sport">' + sport.toUpperCase() + ' · ' + escHtml(otdFormatSeason(sport, p.season)) + '</div>' +
                serialHtml +
                '<div class="otd-card-level" style="border-color:' + rc + '55;background:' + rc + '15">' + levelSel + '</div>' +
            '</div>';
        }).join('') + '</div>';
    }

    function renderOtdResults() {
        var el = document.getElementById('otd-results');
        if (!el) return;

        if (!otdPlayers.length && !otdLoadingPasses) {
            el.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--muted2);font-size:13px">Add players above to see their OTD claimable dates</div>';
            return;
        }
        var numLoading = otdPlayers.filter(function(p) { return p.earnings === null; }).length;
        var anyLoaded = otdPlayers.some(function(p) { return p.earnings !== null; });
        if (otdLoadingPasses || numLoading > 0) {
            var OTD_TIPS = [
                'You get 2 claims per sport per day — and 1 bonus claim for the single best card across all sports.',
                'Holding the same player across multiple seasons means separate claims each day.',
                'Platinum and Pinnacle cards can earn 100x+ more Rax than a Common on the same performance.',
                'A player\'s worst game still earns — any game that hits the OTD threshold counts.',
                'Check the "Check Before You Buy" tool before buying a card to see its exact OTD calendar.',
                'Your 3rd daily claim goes to the highest-earning card across all your sports combined.',
                'Stacking the same player across NFL, NBA, and baseball seasons maximizes daily claim volume.',
                'Team cards earn on every game in a season — they compound fast on playoff runs.',
                'The Find Player tool lets you preview any card\'s OTD calendar before adding it to your account.',
                'Common cards are cheap entry points — but the jump to Rare is worth it if you hold long-term.'
            ];
            var tip = OTD_TIPS[Math.floor(Date.now() / 3000) % OTD_TIPS.length];
            var loadSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="72" height="72">'
                + '<polygon points="256,48 464,256 256,464 48,256" fill="none" stroke="#4f6ef7" stroke-width="40"/>'
                + '<polygon points="256,165 347,256 256,347 165,256" fill="#4f6ef7"/>'
                + '</svg>';
            var loaded = otdPlayers.filter(function(p) { return p.earnings !== null; }).length;
            var total = otdPlayers.length;
            var countStr = total > 0 ? ' <span style="font-family:var(--mono);font-size:11px;color:var(--muted2)">(' + loaded + '/' + total + ')</span>' : '';
            el.innerHTML = '<div class="otd-loading">'
                + '<div class="otd-loading-icon">' + loadSvg + '</div>'
                + '<div class="otd-loading-label">Loading your cards…' + countStr + '</div>'
                + '<div class="otd-loading-tip">' + tip + '</div>'
                + '</div>';
            return;
        }

        // Step 1: group by date → sport → entries
        // Normalize all dates to otdCalYear — OTD claims recur annually on the same MM-DD.
        // Exception: current-season earnings (origYear >= thisYear) are live claims, not OTD yet.
        // Their first OTD date is next year (origYear + 1), so skip them if we're viewing a year
        // that hasn't reached that. E.g. a 2026 July 21 game only appears on July 21, 2027+.
        var thisYear = new Date().getFullYear();

        // Build find-player date set (for highlight overlay — keyed by otdCalYear-MM-DD)
        var findDateSet = {};
        if (otdFindEarnings && otdFindEarnings.length) {
            otdFindEarnings.forEach(function(e) {
                var dp = (e.day || '').split('T')[0].split('-');
                if (dp.length !== 3) return;
                var oy = parseInt(dp[0], 10);
                if (oy >= thisYear && otdCalYear <= oy) return;
                findDateSet[String(otdCalYear) + '-' + dp[1].padStart(2,'0') + '-' + dp[2].padStart(2,'0')] = true;
            });
        }
        var rawDateMap = {};
        otdPlayers.forEach(function(p) {
            if (!p.earnings) return;
            p.earnings.forEach(function(e) {
                var dp = (e.day || '').split('T')[0].trim().split('-');
                if (dp.length !== 3) return;
                var origYear = parseInt(dp[0], 10);
                // Current/future season: first OTD year is origYear+1; skip if viewing year is earlier
                if (origYear >= thisYear && otdCalYear <= origYear) return;
                var dayKey = String(otdCalYear) + '-' + dp[1].padStart(2,'0') + '-' + dp[2].padStart(2,'0');
                if (!rawDateMap[dayKey]) rawDateMap[dayKey] = {};
                var SOCCER_SK = { epl:1, ucl:1, mls:1, fc:1, fifa:1, soccer:1 };
                var sk = SOCCER_SK[p.sport] ? 'soccer' : p.sport;
                if (!rawDateMap[dayKey][sk]) rawDateMap[dayKey][sk] = [];
                rawDateMap[dayKey][sk].push({ player: p, rax: e.atRarityEarnings || 0, origDay: (e.day || '').split('T')[0].trim(), bsId: e.playerBoxScoreId || e.boxScoreId || e.boxscoreId || e.performanceId || e.gameId || null });
            });
        });

        // Step 2: flatten — deduplicate same entity+season per sport per day (keep highest Rax entry).
        // Same player in different seasons = separate claims (e.g. Ohtani '24 and '25 both count).
        // Claims 1-2: top 2 per sport. Claim 3 (Pro): single best 3rd-slot across ALL sports.
        var dateMap = {};
        var totalDates = 0;
        var thirdCandidates = {}; // dayKey → [3rd-slot entries from each sport]
        var overlapMap = {}; // dayKey → [{sport, wasted}]
        Object.keys(rawDateMap).forEach(function(dayKey) {
            Object.keys(rawDateMap[dayKey]).forEach(function(sport) {
                var entityBest = {};
                rawDateMap[dayKey][sport].forEach(function(e) {
                    var ek = e.player.id + '|' + e.player.sport + '|' + e.player.season;
                    if (!entityBest[ek] || (e.rax || 0) > (entityBest[ek].rax || 0)) entityBest[ek] = e;
                });
                var sorted = Object.values(entityBest).sort(function(a, b) { return (b.rax || 0) - (a.rax || 0); });
                var topN = Math.min(2, otdClaimsView);
                sorted.slice(0, topN).forEach(function(entry) {
                    if (!dateMap[dayKey]) { dateMap[dayKey] = []; totalDates++; }
                    dateMap[dayKey].push(entry);
                });
                if (otdClaimsView >= 3 && sorted.length > 2) {
                    if (!thirdCandidates[dayKey]) thirdCandidates[dayKey] = [];
                    thirdCandidates[dayKey].push(sorted[2]);
                }
                // Overlap: entries past claim limit with >199 Rax are wasted
                var wastedStart = topN + (otdClaimsView >= 3 ? 1 : 0);
                var wasted = sorted.slice(wastedStart).filter(function(e) { return (e.rax || 0) >= 200; });
                if (wasted.length) {
                    if (!overlapMap[dayKey]) overlapMap[dayKey] = [];
                    overlapMap[dayKey].push({ sport: sport, wasted: wasted });
                }
            });
            if (otdClaimsView >= 3 && thirdCandidates[dayKey] && thirdCandidates[dayKey].length) {
                var best3rd = thirdCandidates[dayKey].slice().sort(function(a, b) { return (b.rax || 0) - (a.rax || 0); })[0];
                if (!dateMap[dayKey]) { dateMap[dayKey] = []; totalDates++; }
                dateMap[dayKey].push(best3rd);
                // Also mark best3rd's sport's 3rd-slot losers as overlap
                var losers = thirdCandidates[dayKey].filter(function(c) { return c !== best3rd && (c.rax||0) >= 200; });
                if (losers.length) {
                    if (!overlapMap[dayKey]) overlapMap[dayKey] = [];
                    overlapMap[dayKey].push({ sport: '3rd-slot', wasted: losers });
                }
            }
        });
        otdDateMap = dateMap;
        otdOverlapMap = overlapMap;

        var MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        var DAY_HDRS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

        var today = new Date();
        var todayISO = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');

        // Calendar grid for otdCalYear / otdCalMonth
        var firstDay = new Date(otdCalYear, otdCalMonth, 1).getDay(); // 0=Sun
        var daysInMonth = new Date(otdCalYear, otdCalMonth + 1, 0).getDate();
        var daysInPrev = new Date(otdCalYear, otdCalMonth, 0).getDate();

        var cells = '';
        // Day headers
        cells += DAY_HDRS.map(function(d) { return '<div class="otd-cal-hdr">' + d + '</div>'; }).join('');

        // Leading empty cells (prev month)
        for (var i = 0; i < firstDay; i++) {
            var prevDay = daysInPrev - firstDay + 1 + i;
            cells += '<div class="otd-cal-cell otd-other-month"><span class="otd-cal-day-num">' + prevDay + '</span></div>';
        }

        // Monthly total for current month
        var monthKey = otdCalYear + '-' + String(otdCalMonth + 1).padStart(2, '0');
        var monthlyTotal = 0;
        Object.keys(dateMap).forEach(function(dk) {
            if (dk.startsWith(monthKey)) dateMap[dk].forEach(function(e) { monthlyTotal += (e.rax || 0); });
        });

        // Current month cells
        for (var d = 1; d <= daysInMonth; d++) {
            var iso = otdCalYear + '-' + String(otdCalMonth + 1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
            var entries = dateMap[iso] || [];
            var isToday = iso === todayISO;
            var hasClaim = entries.length > 0;
            var isSelected = iso === otdSelectedDay;
            var totalRax = entries.reduce(function(s, e) { return s + (e.rax || 0); }, 0);

            var isFindMatch = !!findDateSet[iso];
            var cls = 'otd-cal-cell' + (hasClaim ? ' otd-has-claim' : '') + (isToday ? ' otd-today' : '') + (isSelected ? ' otd-selected' : '') + (isFindMatch ? ' otd-find-match' : '');
            var raxLbl = hasClaim ? '<span class="otd-cal-rax">' + RAX_ICON + totalRax.toLocaleString() + '</span>' : '';
            var findDot = isFindMatch ? '<span class="otd-find-dot">★</span>' : '';
            var clickAttr = hasClaim ? ' onclick="otdSelectDay(\'' + iso + '\')"' : '';

            cells += '<div class="' + cls + '"' + clickAttr + '>' +
                '<span class="otd-cal-day-num">' + d + '</span>' +
                findDot +
                raxLbl +
            '</div>';
        }

        // Trailing empty cells
        var totalCells = firstDay + daysInMonth;
        var trail = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
        for (var t = 1; t <= trail; t++) {
            cells += '<div class="otd-cal-cell otd-other-month"><span class="otd-cal-day-num">' + t + '</span></div>';
        }

        // Day detail panel (shown below calendar when a day is clicked)
        var dayPanel = '';
        if (otdSelectedDay && dateMap[otdSelectedDay]) {
            var selEntries = dateMap[otdSelectedDay];
            // Group entries by sport, preserving insertion order
            var sportOrder = [];
            var sportGroups = {};
            selEntries.forEach(function(e) {
                var s = e.player.sport;
                if (!sportGroups[s]) { sportGroups[s] = []; sportOrder.push(s); }
                sportGroups[s].push(e);
            });
            sportOrder.sort(function(a, b) {
                var aT = sportGroups[a].reduce(function(x, e) { return x + (e.rax || 0); }, 0);
                var bT = sportGroups[b].reduce(function(x, e) { return x + (e.rax || 0); }, 0);
                return bT - aT;
            });
            var activeSport = (otdSelectedDaySport && sportGroups[otdSelectedDaySport]) ? otdSelectedDaySport : sportOrder[0];
            var activeEntries = sportGroups[activeSport] || [];
            var sportTotal = activeEntries.reduce(function(s, e) { return s + (e.rax || 0); }, 0);

            var selDateObj = new Date(otdSelectedDay + 'T12:00:00');
            var dateLabel = MONTH_NAMES[selDateObj.getMonth()] + ' ' + selDateObj.getDate();

            var sportTabs = sportOrder.map(function(s) {
                var isAct = s === activeSport;
                var sTotal = sportGroups[s].reduce(function(x, e) { return x + (e.rax || 0); }, 0);
                return '<button class="otd-day-tab' + (isAct ? ' active' : '') + '" onclick="otdSelectDaySport(\'' + s + '\')">' +
                    s.toUpperCase() + '<span class="otd-day-tab-rax">' + RAX_ICON + sTotal.toLocaleString() + '</span>' +
                '</button>';
            }).join('');

            var OTD_CARD_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>';
            var OTD_PERF_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';
            var entryRows = activeEntries.map(function(e) {
                var lvl = e.player.level || 0;
                // Cross-reference against loaded passes to fill in missing card visuals (manually-added checks lack these)
                var passRef = otdPlayers.find(function(p) { return String(p.id) === String(e.player.id) && p.sport === e.player.sport; });
                var bgSource = e.player.backgroundSource || (passRef && passRef.backgroundSource) || null;
                var avHash = e.player.avatar || (passRef && passRef.avatar) || '';
                var serial = e.player.serialNumber || (passRef && passRef.serialNumber) || null;
                var rc = e.player.rarityColor || (passRef && passRef.rarityColor) || otdRarityColor(lvl);
                var yearFmt = otdFormatSeason(e.player.sport, e.player.season);
                var eid = String(e.player.id);
                var eet = e.player.entityType || 'player';
                var pId = String(e.player.passId || (passRef && passRef.passId) || '');
                var linkDay = e.origDay || otdSelectedDay;
                var cardBtn = '<button class="otd-link-btn" title="View card on RS" onclick="otdOpenCardLink(\'' + eid + '\',\'' + e.player.sport + '\',\'' + eet + '\',\'' + linkDay + '\',\'' + pId + '\')">' + OTD_CARD_ICON + '</button>';
                var perfBtn = '<button class="otd-link-btn" title="View performance on RS" onclick="otdOpenPerfLink(\'' + eid + '\',\'' + e.player.sport + '\',\'' + eet + '\',\'' + linkDay + '\',\'' + (e.player.season||'') + '\',\'' + (e.bsId||'') + '\')">' + OTD_PERF_ICON + '</button>';
                var bgSrc = bgSource ? '/api/real/otd?action=card_bg&src=' + encodeURIComponent(bgSource) : '';
                var multiplier = e.player.multiplier || (passRef && passRef.multiplier) || null;
                var multNum = multiplier ? parseInt(multiplier, 10) : 0;
                var baseRax = (multNum > 1 && e.rax) ? Math.round(e.rax / multNum) : 0;
                var thumb = '<div class="otd-entry-thumb" style="background:' + rc + '22;' + (bgSrc ? 'background-image:url(' + bgSrc + ');' : '') + '">' +
                    (bgSrc ? '<div class="otd-entry-thumb-overlay"></div>' : '') +
                    '<div class="otd-thumb-topbar">' +
                        (e.player.levelLabel ? '<span class="otd-rarity-badge" style="background:' + rc + ';margin:0;font-size:8px;padding:1px 4px">' + escHtml(e.player.levelLabel) + '</span>' : '<span></span>') +
                        '<span class="otd-thumb-year">' + escHtml(yearFmt) + '</span>' +
                    '</div>' +
                    (avHash ? '<img src="https://media.realapp.com/assets/players/default/small/' + avHash + '.webp" class="otd-mini-card-av" onerror="this.style.display=\'none\'">' : '') +
                    '<div class="otd-thumb-bottom"></div>' +
                '</div>';
                var playerIdx = otdPlayers.indexOf(e.player);
                var rarSel = playerIdx >= 0 ? '<select class="otd-level-sel" style="color:' + rc + '" onchange="otdChangeLevel(' + playerIdx + ',parseInt(this.value,10))" title="Change rarity">' +
                    OTD_LEVEL_OPTIONS.map(function(o) { return '<option value="' + o.value + '"' + (o.value === lvl ? ' selected' : '') + '>' + escHtml(o.label) + '</option>'; }).join('') +
                    '</select>' : '';
                var isSimPass = !!(e.player.isAdded);
                var simBadge = isSimPass ? '<span style="display:inline-block;font-size:8px;font-weight:700;color:#fff;background:#7c3aed;padding:1px 5px;border-radius:3px;letter-spacing:.4px;margin-left:4px;vertical-align:middle">SIM</span>' : '';
                var tile = '<div class="otd-day-entry" style="border-color:' + rc + '55">' +
                    thumb +
                    '<div class="otd-entry-tile-body">' +
                        '<div class="otd-entry-tile-name">' + escHtml(e.player.name) + simBadge + '</div>' +
                        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">' +
                            '<span class="otd-day-entry-rax">' + RAX_ICON + (e.rax || 0).toLocaleString() + '</span>' +
                            (baseRax ? '<span style="font-size:8px;color:var(--muted);font-family:var(--mono)">' + baseRax.toLocaleString() + '×' + multNum + 'x</span>' : '') +
                        '</div>' +
                    '</div>' +
                '</div>';
                var actions = '<div class="otd-entry-actions">' +
                    rarSel + cardBtn + perfBtn +
                '</div>';
                return '<div class="otd-entry-wrap">' + tile + actions + '</div>';
            }).join('');

            dayPanel = '<div class="otd-day-panel">' +
                '<div class="otd-day-panel-hdr">' +
                    '<span style="font-size:13px;font-weight:700">' + dateLabel + '</span>' +
                    '<button onclick="otdCloseDay()" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;line-height:1;padding:0">×</button>' +
                '</div>' +
                '<div class="otd-day-tabs">' + sportTabs + '</div>' +
                '<div class="otd-day-entries">' + entryRows + '</div>' +
                '<div class="otd-day-total">' + RAX_ICON + sportTotal.toLocaleString() + ' from ' + activeSport.toUpperCase() + '</div>' +
            '</div>';
        }

        var pro = isPro();
        var btnBase = 'font-family:var(--sans);font-size:11px;font-weight:700;padding:4px 10px;border-radius:5px;cursor:pointer;border:1px solid ';
        var btn2Style = btnBase + (otdClaimsView === 2 ? 'var(--accent);background:rgba(99,102,241,.12);color:var(--accent)' : 'var(--border2);background:var(--bg3);color:var(--muted)');
        var btn3Style = btnBase + (otdClaimsView === 3 ? 'var(--accent);background:rgba(99,102,241,.12);color:var(--accent)' : 'var(--border2);background:var(--bg3);color:var(--muted)') + (pro ? '' : ';opacity:.45;cursor:not-allowed');

        var addedPlayers = otdPlayers.filter(function(p) { return p.isAdded; });
        var addedNote = addedPlayers.length ? (
            '<div style="background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.3);border-radius:6px;padding:8px 12px;margin-bottom:10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px">' +
                '<span style="color:var(--muted2);font-weight:600;flex-shrink:0">Simulated:</span>' +
                addedPlayers.map(function(p) {
                    return '<span style="background:' + p.color + '22;border:1px solid ' + p.color + '55;border-radius:12px;padding:2px 8px;font-size:11px;font-weight:700">' +
                        escHtml(p.name) + ' · ' + p.sport.toUpperCase() + ' ' + otdFormatSeason(p.sport, p.season) + ' · ' + escHtml(p.levelLabel) +
                    '</span>';
                }).join('') +
            '</div>'
        ) : '';

        // Overlap panel
        var overlapKeys = Object.keys(otdOverlapMap).sort(function(a, b) {
            if (otdOverlapSort === 'date-asc') return a < b ? -1 : a > b ? 1 : 0;
            if (otdOverlapSort === 'date-desc') return a > b ? -1 : a < b ? 1 : 0;
            var at = otdOverlapMap[a].reduce(function(s, g) { return s + g.wasted.reduce(function(x, e) { return x + (e.rax||0); }, 0); }, 0);
            var bt = otdOverlapMap[b].reduce(function(s, g) { return s + g.wasted.reduce(function(x, e) { return x + (e.rax||0); }, 0); }, 0);
            return otdOverlapSort === 'rax-asc' ? at - bt : bt - at;
        });
        var overlapCount = overlapKeys.length;
        var overlapBtnStyle = btnBase + (otdShowOverlaps ? 'var(--accent);background:rgba(99,102,241,.12);color:var(--accent)' : 'var(--border2);background:var(--bg3);color:var(--muted)');
        var overlapPanel = '';
        if (otdShowOverlaps && overlapCount > 0) {
            var MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            var OVL_CARD_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>';
            var OVL_PERF_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';
            var overlapRows = overlapKeys.slice(0, 60).map(function(dk) {
                var parts = dk.split('-');
                var dateStr = MONTH_SHORT[parseInt(parts[1],10)-1] + ' ' + parseInt(parts[2],10);
                var groups = otdOverlapMap[dk];
                return groups.map(function(g) {
                    var sportLabel = g.sport === '3rd-slot' ? '3rd slot beaten' : g.sport.toUpperCase();
                    var sportColor = g.sport === '3rd-slot' ? '#9c27b0' : 'var(--muted)';
                    return g.wasted.map(function(w) {
                        var lbl = (OTD_LEVEL_OPTIONS.find(function(o){return o.value===w.player.level;})||{}).label || '';
                        var yr = escHtml(otdFormatSeason(w.player.sport, w.player.season));
                        var linkDay = w.origDay || dk;
                        var pid = w.player.passId || '';
                        var eid = String(w.player.id || '');
                        var eet = w.player.entityType || 'player';
                        var sp = w.player.sport || '';
                        var cBtn = eid ? '<button class="otd-link-btn" style="padding:2px 4px" title="View card" onclick="otdOpenCardLink(\'' + eid + '\',\'' + sp + '\',\'' + eet + '\',\'' + linkDay + '\',\'' + pid + '\')">' + OVL_CARD_ICON + '</button>' : '';
                        var pBtn = eid ? '<button class="otd-link-btn" style="padding:2px 4px" title="View performance" onclick="otdOpenPerfLink(\'' + eid + '\',\'' + sp + '\',\'' + eet + '\',\'' + linkDay + '\',\'' + (w.player.season||'') + '\',\'' + (w.bsId||'') + '\')">' + OVL_PERF_ICON + '</button>' : '';
                        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px;gap:6px">' +
                            '<div style="flex:1;min-width:0">' +
                                '<span style="font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap;margin-right:6px">' + escHtml(dateStr) + '</span>' +
                                '<span style="font-weight:600;color:var(--fg)">' + escHtml(w.player.name) + '</span>' +
                                (lbl ? '<span style="font-size:9px;background:' + (w.player.rarityColor||'var(--muted)')+';color:#fff;border-radius:3px;padding:1px 4px;margin-left:5px;font-weight:700">' + escHtml(lbl) + '</span>' : '') +
                                '<span style="font-size:10px;color:var(--muted);margin-left:5px">' + yr + '</span>' +
                                '<span style="font-size:9px;color:' + sportColor + ';margin-left:5px;font-weight:600">' + escHtml(sportLabel) + '</span>' +
                            '</div>' +
                            '<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">' +
                                '<span style="font-family:var(--mono);font-size:11px;font-weight:700;color:#ef5350">' + RAX_ICON + (w.rax||0).toLocaleString() + '</span>' +
                                cBtn + pBtn +
                            '</div>' +
                        '</div>';
                    }).join('');
                }).join('');
            }).join('');
            var overlapTotal = overlapKeys.reduce(function(s, dk) {
                return s + otdOverlapMap[dk].reduce(function(a, g) { return a + g.wasted.reduce(function(x, e) { return x + (e.rax||0); }, 0); }, 0);
            }, 0);
            var ovlSortBase = 'font-family:var(--sans);font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;cursor:pointer;border:1px solid ';
            var ovlSortBtn = function(mode, label) {
                var active = otdOverlapSort === mode;
                return '<button onclick="otdSetOverlapSort(\'' + mode + '\')" style="' + ovlSortBase + (active ? 'var(--accent);background:rgba(99,102,241,.15);color:var(--accent)' : 'var(--border2);background:var(--bg3);color:var(--muted)') + '">' + label + '</button>';
            };
            overlapPanel = '<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:8px;margin-bottom:10px;overflow:hidden">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:6px">' +
                    '<span style="font-size:12px;font-weight:700;color:var(--fg)">' + overlapCount + ' days with overlapping claims</span>' +
                    '<div style="display:flex;align-items:center;gap:4px">' +
                        '<span style="font-size:10px;color:var(--muted2);margin-right:2px">Sort:</span>' +
                        ovlSortBtn('date-asc', 'Date ↑') +
                        ovlSortBtn('date-desc', 'Date ↓') +
                        ovlSortBtn('rax-desc', 'Rax ↓') +
                        ovlSortBtn('rax-asc', 'Rax ↑') +
                        '<span style="font-family:var(--mono);font-size:11px;font-weight:700;color:#ef5350;margin-left:6px">' + RAX_ICON + overlapTotal.toLocaleString() + '</span>' +
                    '</div>' +
                '</div>' +
                '<div style="max-height:260px;overflow-y:auto">' + overlapRows + '</div>' +
            '</div>';
        } else if (otdShowOverlaps && overlapCount === 0) {
            overlapPanel = '<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:8px;margin-bottom:10px;padding:12px 14px;font-size:12px;color:var(--muted2)">No overlapping claims above 199 Rax — your collection is clean.</div>';
        }

        var calHtml =
            addedNote +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
                '<div style="font-size:11px;color:var(--muted2)">' + totalDates + ' claimable dates' + (numLoading > 0 ? ' · <span style="color:var(--accent)">loading ' + numLoading + '…</span>' : '') + '</div>' +
                '<div style="display:flex;gap:4px;align-items:center">' +
                    '<button style="' + btn2Style + '" onclick="otdSetClaimsView(2)">2 claims</button>' +
                    '<button style="' + btn3Style + '" onclick="otdSetClaimsView(3)" title="' + (pro ? '3 claims/sport' : 'Pro required') + '">3 claims' + (pro ? '' : ' 🔒') + '</button>' +
                    (overlapCount > 0 ? '<button style="' + overlapBtnStyle + '" onclick="otdToggleOverlaps()" title="Days where you have more cards than claim slots">⚠ Overlaps' + (overlapCount ? ' ' + overlapCount : '') + '</button>' : '') +
                '</div>' +
            '</div>' +
            overlapPanel +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
                '<button onclick="otdPrevMonth()" style="background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-size:16px;width:32px;height:32px;border-radius:6px;cursor:pointer;line-height:1">‹</button>' +
                '<div style="text-align:center">' +
                    '<div style="font-size:15px;font-weight:700">' + MONTH_NAMES[otdCalMonth] + ' ' + otdCalYear + '</div>' +
                    (monthlyTotal > 0 ? '<div style="font-size:11px;font-family:var(--mono);font-weight:700;color:#22c55e;display:flex;align-items:center;justify-content:center;gap:2px;margin-top:1px">' + RAX_ICON + monthlyTotal.toLocaleString() + '</div>' : '') +
                '</div>' +
                '<button onclick="otdNextMonth()" style="background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-size:16px;width:32px;height:32px;border-radius:6px;cursor:pointer;line-height:1">›</button>' +
            '</div>' +
            '<div class="otd-cal-grid">' + cells + '</div>' +
            dayPanel;

        if (otdPassesOpen) {
            el.innerHTML =
                '<div style="display:flex;gap:16px;align-items:flex-start">' +
                    '<div style="flex:1;min-width:0">' + calHtml + '</div>' +
                    '<div id="otd-passes-panel-wrap" style="width:290px;flex-shrink:0;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:14px;position:sticky;top:72px"></div>' +
                '</div>';
            renderOtdPassesPanel();
        } else {
            el.innerHTML = calHtml;
        }
        renderOtdCheckWrap();
    }

    // Compute EV for a sport's rows and cache+render immediately — safe to call in parallel
    // (uses sport param explicitly, never reads currentSport)
    function computeAndCacheEv(sportRows, sportKey, syncData) {
        if (!sportRows || !sportRows.length) return;
        if (syncData) {
            fillPredsFromSync(sportRows, syncData);
            lastSyncData[sportKey] = syncData;
        }
        var pairs = {};
        sportRows.forEach(function(r) { if (!pairs[r.pid]) pairs[r.pid] = {}; pairs[r.pid][r.ps] = r; });
        var computed = sportRows.map(function(r) {
            var p = pairs[r.pid] || {};
            var nv = novig(p.A ? imp(p.A.am) : null, p.B ? imp(p.B.am) : null);
            var yl = yourLines[r.id] != null ? yourLines[r.id] : null;
            var altNV = getAltFair(r, yl, p.A, p.B);
            var fair = r._wcFair != null ? r._wcFair : (r.mkt === 'RFI' && r.rfiFair != null) ? r.rfiFair : (altNV ? (r.ps === 'A' ? altNV.fa : altNV.fb) : (r.ps === 'A' ? nv.fa : nv.fb));
            var af   = r._wcFair != null ? r._wcFair : (r.mkt === 'RFI' && r.rfiFair != null) ? r.rfiFair : (altNV ? fair : adjFair(fair, r.pt, yl, r.mkt, r.ps, sportKey));
            var pr = preds[r.id];
            var pred = (pr !== undefined && pr !== '') ? Math.min(0.999, Math.max(0.001, (probsExact[r.id] != null ? probsExact[r.id] : parseFloat(pr) / 100))) : null;
            var evForUnits = null;
            if (af != null && pred != null && pred > 0 && pred < 1) {
                evForUnits = (af * (1/pred) * (1-rsBaseTake(pred)) - 1) * 100;
            }
            var u = unitsEV(evForUnits, pred);
            var edge = (af != null && pred != null) ? (af - pred) * 100 : null;
            return { id: r.id, game: r.game, cm: r.cm, mkt: r.mkt, side: r.side, am: r.am, pt: r.pt, ps: r.ps, pid: r.pid, gid: r.gid, league: r.league, fair: fair, af: af, yl: yl, edge: edge, u: u, _sport_key: sportKey, _wcFair: r._wcFair };
        }).filter(function(r) {
            if ((sportKey === 'basketball_nba' || sportKey === 'icehockey_nhl') && r.gid && r.yl != null && r.pt != null && (r.mkt === 'Spread' || r.mkt === 'Total')) {
                if (Math.abs(parseFloat(r.yl) - parseFloat(r.pt)) > 0.001) {
                    var dkGame = dkAltOdds[r.gid];
                    if (!dkGame) return false;
                    var dkSideKey = r.ps === 'A' ? (r.mkt === 'Spread' ? 'Away' : 'Over') : (r.mkt === 'Spread' ? 'Home' : 'Under');
                    var dkLines = r.mkt === 'Spread' ? (dkGame.spreads && dkGame.spreads[dkSideKey]) : (dkGame.totals && dkGame.totals[dkSideKey]);
                    if (!dkLines || dkClosestPrice(dkLines, parseFloat(r.yl)) == null) return false;
                }
            }
            return true;
        });
        cacheEvRows(computed, sportKey);
    }

    function cacheEvRows(rows, sport, skipRender) {
        // Only show rows with a prediction AND positive EV
        var positive = [];
        rows.forEach(function(r) {
            // RFI rows store fair in rfiFair — normalise to af
            if (r.mkt === 'RFI' && r.rfiFair != null) r.af = r.rfiFair;
            // WC rows store pre-computed 3-way novig fair in _wcFair
            if (r._wcFair != null) r.af = r._wcFair;
            if (r.af == null) return;
            r._pred = null; r._rake = 0.034; r._ev = null;
            var pr = preds[r.id];
            if (!pr || pr === '') return;
            var pred = probsExact[r.id] != null ? probsExact[r.id] : parseFloat(pr) / 100;
            if (pred <= 0 || pred >= 1) return;
            var rake = rsBaseTake(pred);
            r._pred = pred; r._rake = rake;
            r._ev   = (r.af * (1/pred) * (1-rake) - 1) * 100;
            // >100% EV is a post-game artifact (RS knows result, FD market not yet settled)
            // Exception: soccer_fc live ±0.5 lines can legitimately produce >100% EV
            if (r._ev > 0 && (r._ev <= 100 || sport === 'soccer_fc' || sport === 'soccer_wc')) {
                // NBA/NHL: lines match → use FD odds. Lines differ → need DK alt at RS line, skip if missing.
                if ((sport === 'basketball_nba' || sport === 'icehockey_nhl') && r.gid && r.yl != null && r.pt != null && (r.mkt === 'Spread' || r.mkt === 'Total')) {
                    if (Math.abs(parseFloat(r.yl) - parseFloat(r.pt)) > 0.001) {
                        var dkGame3 = dkAltOdds[r.gid];
                        if (!dkGame3) return;
                        var sk3 = r.ps === 'A' ? (r.mkt === 'Spread' ? 'Away' : 'Over') : (r.mkt === 'Spread' ? 'Home' : 'Under');
                        var dl3 = r.mkt === 'Spread' ? (dkGame3.spreads && dkGame3.spreads[sk3]) : (dkGame3.totals && dkGame3.totals[sk3]);
                        if (!dl3 || dkClosestPrice(dl3, parseFloat(r.yl)) == null) return;
                    }
                }
                r._sortVal = r._ev; positive.push(r);
            }
        });
        positive.sort(function(a, b) { return b._sortVal - a._sortVal; });
        var sportLabel = (SPORTS.find(function(s) { return s.key === sport; }) || {}).label || sport;
        positive.forEach(function(r) { r._sport = sportLabel; r._sport_key = sport; });
        // Always overwrite — empty rows means no active games for this sport
        evTabCache[sport] = positive;
        if (!skipRender && evTabVisible && !evLoadingInProgress) renderEvTab();
    }

    // Called when user edits a Real% input on a Best EV row (desktop table or mobile card)
    function evCardUpdate(cardId, inputEl) {
        var val = parseFloat(inputEl.value);
        // Find the containing row/card — could be <tr> (desktop) or <div class="ev-mobile-card"> (mobile)
        var container = inputEl.closest('tr') || inputEl.closest('.ev-mobile-card');
        if (!container) return;
        if (!isFinite(val) || val <= 0 || val >= 100) {
            var evTd = container.querySelector('.ev-val-td');
            var uTd  = container.querySelector('.ev-units-td');
            var btTd = container.querySelector('.ev-bet-td');
            if (evTd) evTd.innerHTML = '<span style="color:var(--muted2)">—</span>';
            if (uTd)  uTd.textContent = '—';
            if (btTd) btTd.textContent = '—';
            return;
        }
        var pred = Math.min(0.999, Math.max(0.001, val / 100 + rsPredAdj / 100));
        var r = null;
        Object.values(evTabCache).forEach(function(arr) {
            arr.forEach(function(x) { if (x.id === cardId) r = x; });
        });
        var rake = rsBaseTake(pred);
        var af   = (r && r.af != null)   ? r.af    : null;
        if (!af) return;
        var ev     = (af * (1/pred) * (1-rake) - 1) * 100;
        var u      = unitsEV(ev, pred);
        var evStr  = (ev >= 0 ? '+' : '') + ev.toFixed(1) + '%';
        var evColor = ev >= 10 ? 'var(--green)' : ev >= 5 ? '#7ddfab' : ev > 0 ? 'var(--yellow)' : 'var(--red)';
        var uColor  = u >= 2 ? 'var(--green)' : u >= 1 ? '#7ddfab' : u >= 0.5 ? 'var(--yellow)' : 'var(--muted)';
        var evUnit  = parseFloat(document.getElementById('ev-unit-size').value) || 300;
        var betAmt  = (u > 0) ? RAX_ICON + Math.round(u * evUnit) : '—';
        var evTd = container.querySelector('.ev-val-td');
        var uTd  = container.querySelector('.ev-units-td');
        var btTd = container.querySelector('.ev-bet-td');
        if (evTd) {
            var isMobileCard = container.classList.contains('ev-mobile-card');
            if (isMobileCard) {
                evTd.style.color = evColor;
                evTd.textContent = 'EV% ' + evStr;
            } else {
                evTd.innerHTML = '<span style="font-family:var(--mono);font-size:12px;font-weight:800;color:' + evColor + '">' + escHtml(evStr) + '</span>';
            }
        }
        if (uTd)  { uTd.textContent = u > 0 ? '+' + u.toFixed(2) + 'u' : '—'; uTd.style.color = uColor; }
        if (btTd) btTd.innerHTML = betAmt;
    }

    function renderEvTab() {
        var container = document.getElementById('ev-cards');
        if (!container) return;
        // Build set of active game strings per sport (from last-fetched odds data)
        var activeGamesBySport = {};
        Object.keys(rawRowsBySport).forEach(function(sk) {
            var s = new Set();
            (rawRowsBySport[sk] || []).forEach(function(r) { s.add(r.game); });
            activeGamesBySport[sk] = s;
        });

        // Flatten cached sports, dropping finished games (live games are kept)
        var nowMs = Date.now();
        var SPORT_DUR_MS = {
            'baseball_mlb': 4 * 3600000,
            'americanfootball_nfl': 4 * 3600000,
            'basketball_nba': 3 * 3600000,
            'basketball_wnba': 3 * 3600000,
            'basketball_ncaab': 3 * 3600000,
            'icehockey_nhl': 3 * 3600000,
            'soccer_fc': 2.5 * 3600000,
            'soccer_wc': 2.5 * 3600000,
            'baseball_cws': 4 * 3600000,
        };
        var all = [];
        Object.values(evTabCache).forEach(function(arr) {
            arr.forEach(function(r) {
                if (r.cm) {
                    var cmMs = r.cm.getTime();
                    var started = cmMs < nowMs;
                    if (started) {
                        // Past max game duration → definitely over
                        var durMs = SPORT_DUR_MS[r._sport_key] || (3.5 * 3600000);
                        if (cmMs + durMs < nowMs) return;
                        // RS showing extreme confidence post-start → game settled
                        if (r._pred && (r._pred > 0.90 || r._pred < 0.10)) return;
                    }
                }
                // Sport data refreshed but game no longer in feed → finished
                var active = activeGamesBySport[r._sport_key];
                if (active && active.size > 0 && !active.has(r.game)) return;
                all.push(r);
            });
        });
        // Optionally hide rows the user has already checked off
        if (evHideTaken) all = all.filter(function(r) { return !betTaken[r.id]; });
        // Apply RS% adjustment — same sensitivity analysis as the main tab's RS+% button
        if (rsPredAdj) {
            all = all.map(function(r) {
                if (!r._pred || r.af == null) return r;
                var adjPred = Math.min(0.999, Math.max(0.001, r._pred + rsPredAdj / 100));
                var adjRake = rsBaseTake(adjPred);
                var adjEv   = (r.af * (1 / adjPred) * (1 - adjRake) - 1) * 100;
                var adjU    = unitsEV(adjEv, adjPred);
                return Object.assign({}, r, { _ev: adjEv, _pred: adjPred, u: adjU });
            }).filter(function(r) { return r._ev > 0; });
        }
        // Apply minimum EV floor set by the user
        if (evMinEv > 0) all = all.filter(function(r) { return (r._ev || 0) >= evMinEv; });
        // Sort by EV descending
        all.sort(function(a, b) { return (b._ev || 0) - (a._ev || 0); });
        if (!all.length) {
            var hasCache = Object.keys(evTabCache).length > 0;
            container.innerHTML = '<div style="text-align:center;padding:60px 20px">'
                + '<div style="font-size:28px;margin-bottom:12px">📭</div>'
                + '<div style="font-family:var(--mono);font-weight:700;font-size:14px;color:var(--fg);margin-bottom:8px">No positive EV lines right now</div>'
                + '<div style="font-size:12px;color:var(--muted);line-height:1.6">'
                + (hasCache ? 'All current lines are negative EV — check back as odds move.' : 'Loading data… navigate to a sport tab first or wait for preload.')
                + '</div>'
                + '</div>';
            return;
        }
        var evUnit = parseFloat(document.getElementById('ev-unit-size').value) || 300;

        // ── Desktop table ──────────────────────────────────────
        var html = '<div class="admin-table-wrap ev-desktop-table"><table class="port-table" style="table-layout:fixed">'
            + '<thead><tr>'
            + '<th style="width:28px"></th>'
            + '<th style="width:72px" class="r">EV%</th>'
            + '<th style="width:28px;padding:0 3px"></th>'
            + '<th style="width:50px">Sport</th>'
            + '<th>Game</th>'
            + '<th style="width:100px">Market</th>'
            + '<th style="width:110px">Side</th>'
            + '<th style="width:60px" class="r">FD</th>'
            + '<th style="width:68px" class="r">Adj Fair</th>'
            + '<th style="width:80px" class="r">Real%</th>'
            + '<th style="width:58px" class="r">Units</th>'
            + '<th style="width:68px" class="r">Bet</th>'
            + '</tr></thead><tbody>';

        // ── Mobile card grid ───────────────────────────────────
        var mhtml = '<div class="ev-mobile-grid">';

        all.forEach(function(r) {
            // Always use _ev for display — payoutRatios uses a stale af snapshot that
            // diverges from current r.af as live FD odds move, producing wrong sign.
            var ev = r._ev;
            var evStr   = ev != null ? (ev >= 0 ? '+' : '') + ev.toFixed(1) + '%' : null;
            var evColor = ev != null ? (ev >= 10 ? 'var(--green)' : ev >= 5 ? '#7ddfab' : ev > 0 ? 'var(--yellow)' : 'var(--red)') : '';
            var u       = r.u != null ? r.u : 0;
            var uColor  = u >= 2 ? 'var(--green)' : u >= 1 ? '#7ddfab' : u >= 0.5 ? 'var(--yellow)' : 'var(--muted)';
            var uStr    = (ev != null && u > 0) ? '+' + u.toFixed(2) + 'u' : '—';
            var betAmt  = (u > 0) ? RAX_ICON + Math.round(u * evUnit) : '—';
            var displayPt = (yourLines[r.id] != null) ? yourLines[r.id] : r.pt;
            var mktLabel = fmtMkt(r.mkt) + (displayPt != null ? ' ' + (displayPt >= 0 ? '+' : '') + displayPt : '');
            var amStr   = (r.am >= 0 ? '+' : '') + r.am;
            var afStr   = r.af != null ? (r.af * 100).toFixed(1) + '%' : '—';
            var predPct = r._pred != null ? (r._pred * 100).toFixed(1) : '';
            var teams   = (r.game || '').split(' @ ');
            var away    = teams[0] || r.game || '';
            var home    = teams[1] || '';
            var gameStr = away + (home ? ' @ ' + home : '');
            var taken   = !!betTaken[r.id];
            var autoFrom = taken ? (autoTakenFrom[r.id] || null) : null; // team name bet on the other side
            var rsUrl   = '';
            if (rsGameIds[r.game]) {
                rsUrl = getRealSportsUrl(rsGameIds[r.game], r._sport_key, r.league, r.game) || '';
            }
            var _evRsUrl = rsMarketIds[r.id] ? getRealSportsMarketUrl(rsMarketIds[r.id]) : rsUrl;
            var _evRsIconTd = _evRsUrl ? '<a href="' + escHtml(_evRsUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="View on Real Sports" class="rs-icon-btn">' + RS_LOGO_SVG + '</a>' : '';

            // Desktop table row
            var ti = timeInfo(r.cm);
            var timeBadge = ti.lbl ? '<span class="gh-badge ' + ti.cls + '" style="font-size:9px;padding:2px 5px;margin-left:5px;vertical-align:middle">' + escHtml(ti.lbl) + '</span>' : '';

            var evCell = evStr
                ? '<span style="font-family:var(--mono);font-size:12px;font-weight:800;color:' + evColor + '">' + escHtml(evStr) + '</span>'
                : '—';
            var trStyle = (ev != null && ev >= 10 ? 'port-card-win' : '') + (taken ? ' ev-row-taken' : '');
            var cbHtml  = '<input type="checkbox" data-id="' + escHtml(r.id) + '" '
                + (taken ? 'checked ' : '')
                + 'onchange="toggleBet(this.dataset.id)" title="Mark bet taken" '
                + 'style="width:15px;height:15px;cursor:pointer;accent-color:var(--green)">';
            var autoTag = autoFrom
                ? '<span style="display:inline-block;font-size:9px;font-weight:700;color:#f5a623;background:rgba(245,166,35,0.12);border:1px solid rgba(245,166,35,0.3);border-radius:3px;padding:1px 4px;margin-left:4px;white-space:nowrap;letter-spacing:.04em;vertical-align:middle">' + (autoFrom === '__auto__' ? 'Other side taken' : 'Took ' + escHtml(autoFrom)) + '</span>'
                : (taken ? '<span style="display:inline-block;font-size:9px;font-weight:700;color:#4caf50;background:rgba(76,175,80,0.12);border:1px solid rgba(76,175,80,0.3);border-radius:3px;padding:1px 4px;margin-left:4px;white-space:nowrap;letter-spacing:.04em;vertical-align:middle">Taken</span>' : '');
            var trRowStyle = taken ? 'opacity:0.4' + (autoFrom ? ';border-left:3px solid #f5a623' : '') : '';
            html += '<tr class="' + trStyle.trim() + '" data-row-id="' + escHtml(r.id) + '" style="' + trRowStyle + '">'
                + '<td>' + cbHtml + '</td>'
                + '<td class="r ev-val-td">' + evCell + '</td>'
                + '<td style="width:28px;padding:0 3px;text-align:center">' + _evRsIconTd + '</td>'
                + '<td><span style="font-size:9px;font-weight:800;letter-spacing:.07em;color:var(--muted2);text-transform:uppercase;white-space:nowrap">' + escHtml(r._sport || '') + '</span></td>'
                + '<td style="font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(gameStr) + timeBadge + autoTag + '</td>'
                + '<td><span class="mkt-badge" style="font-size:10px">' + escHtml(mktLabel) + '</span></td>'
                + '<td style="font-weight:700;font-size:12px">' + escHtml(r.side || '') + '</td>'
                + '<td class="r" style="font-family:var(--mono);font-size:12px;color:var(--muted)">' + escHtml(amStr) + '</td>'
                + '<td class="r" style="font-family:var(--mono);font-size:12px;color:var(--fg);font-weight:600">' + escHtml(afStr) + '</td>'
                + '<td class="r"><input type="number" min="1" max="99" step="1" value="' + escHtml(Math.round(parseFloat(predPct) || 0) || '') + '" '
                +   'data-ev-id="' + escHtml(r.id) + '" oninput="evCardUpdate(this.dataset.evId,this)" placeholder="—" '
                +   'style="width:58px;background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--mono);font-size:11px;font-weight:600;padding:3px 5px;border-radius:4px;text-align:right" /></td>'
                + '<td class="r ev-units-td" style="font-family:var(--mono);font-size:11px;font-weight:700;color:' + uColor + '">' + escHtml(uStr) + '</td>'
                + '<td class="r ev-bet-td" style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--muted)">' + betAmt + '</td>'
                + '</tr>';

            // Mobile card
            var cardCls = 'ev-mobile-card' + (ev != null && ev >= 10 ? ' ev-card-win' : '') + (taken && !autoFrom ? ' ev-card-taken' : '') + (taken && autoFrom ? ' ev-card-auto-taken' : '');
            var _evRsIconMob = _evRsUrl ? '<a href="' + escHtml(_evRsUrl) + '" target="_blank" rel="noopener" class="rs-icon-btn" title="View on Real Sports" onclick="event.stopPropagation()">' + RS_LOGO_SVG + '</a>' : '';
            mhtml += '<div class="' + cardCls + '" data-row-id="' + escHtml(r.id) + '">'
                // Top row: sport + EV%
                + '<div style="display:flex;align-items:center;justify-content:space-between;gap:2px">'
                +   '<span class="evm-sport">' + escHtml(r._sport || '') + '</span>'
                +   '<span class="evm-ev ev-val-td" style="color:' + evColor + '">EV% ' + escHtml(evStr || '—') + '</span>'
                + '</div>'
                // Teams stacked
                + '<div class="evm-team">' + escHtml(away) + '</div>'
                + (home ? '<div class="evm-team evm-home">@ ' + escHtml(home) + '</div>' : '')
                + (timeBadge ? '<div style="margin-top:2px">' + timeBadge + '</div>' : '')
                // Market + Side + FD odds
                + '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:1px">'
                +   '<span class="evm-mkt">' + escHtml(mktLabel) + '</span>'
                +   '<span class="evm-side">' + escHtml(r.side || '') + '</span>'
                +   '<span class="evm-odds">' + escHtml(amStr) + '</span>'
                + '</div>'
                // Real% input
                + '<div style="margin-top:3px">'
                +   '<input type="number" min="1" max="99" step="1" class="evm-real-input" placeholder="Real%" '
                +   'value="' + escHtml(Math.round(parseFloat(predPct) || 0) || '') + '" '
                +   'data-ev-id="' + escHtml(r.id) + '" oninput="evCardUpdate(this.dataset.evId,this)" />'
                + '</div>'
                // Units + Bet
                + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">'
                +   '<span class="evm-units ev-units-td" style="color:' + uColor + '">' + escHtml(uStr) + '</span>'
                +   '<span class="evm-bet ev-bet-td">' + betAmt + '</span>'
                + '</div>'
                // Footer: RS icon (bottom-left) + taken badge + checkbox (right)
                + '<div class="evm-footer">'
                +   '<div style="display:flex;align-items:center;gap:5px">'
                +     _evRsIconMob
                +     (autoFrom ? '<span style="font-size:9px;font-weight:700;color:#f5a623;background:rgba(245,166,35,0.12);border:1px solid rgba(245,166,35,0.3);border-radius:3px;padding:2px 5px;letter-spacing:.04em">' + (autoFrom === '__auto__' ? 'Other side taken' : 'Took ' + escHtml(autoFrom)) + '</span>' : (taken ? '<span style="font-size:9px;font-weight:700;color:#4caf50;background:rgba(76,175,80,0.12);border:1px solid rgba(76,175,80,0.3);border-radius:3px;padding:2px 5px;letter-spacing:.04em">Taken</span>' : ''))
                +   '</div>'
                +   '<input type="checkbox" class="evm-cb" data-id="' + escHtml(r.id) + '" '
                +   (taken ? 'checked ' : '') + 'onchange="toggleBet(this.dataset.id)" title="Mark bet taken">'
                + '</div>'
                + '</div>';
        });

        html  += '</tbody></table></div>';
        mhtml += '</div>';
        container.innerHTML = html + mhtml;
        var status = document.getElementById('ev-load-status');
        if (status) status.textContent = all.length + ' positive EV bets across ' + Object.keys(evTabCache).length + ' sport' + (Object.keys(evTabCache).length !== 1 ? 's' : '');
    }

    async function loadAllEvSports() {
        var btn = document.getElementById('ev-load-btn');
        var status = document.getElementById('ev-load-status');
        if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
        var sportsToLoad = SPORTS.filter(function(s) { return !s.noFetch; });
        var total = sportsToLoad.length;
        var done = 0;
        function updateStatus() {
            if (status) status.textContent = 'Loading ' + done + '/' + total + '…';
        }
        updateStatus();

        // Re-verify plan in parallel with odds fetch — don't block start
        fetch('/api/auth/me', { credentials: 'same-origin' })
            .then(function(r) { if (r.ok) return r.json(); })
            .then(function(u) { if (u) { currentUser = u; if (!isPro()) { renderEvTab(); } if (isPro()) loadGroupCode(); } })
            .catch(function() {});

        // Re-fetch fresh odds for all sports in parallel — this evicts finished games from rawRowsBySport
        evLoadingInProgress = true;
        var _evLoadTimeout = setTimeout(function() {
            evLoadingInProgress = false;
            if (btn) { btn.disabled = false; btn.textContent = '↺ Refresh'; }
        }, 25000);
        var noSpread = ['mma_mixed_martial_arts', 'baseball_mlb'];
        var freshSyncData = {}; // sport key -> RS sync response fetched in parallel with odds
        await Promise.all(sportsToLoad.map(async function(s) {
            try {
                if (s.key === 'soccer_wc') {
                    // WC KO: DK "To Advance" (subcat 5826) — 2-way ML, includes ET + pens
                    var wcEvRes = await fetch('/api/fd/wc', { credentials: 'same-origin' });
                    var wcEvData = wcEvRes.ok ? await wcEvRes.json() : null;
                    if (!wcEvData || !wcEvData.ok || !wcEvData.games) return;
                    var wcEvRows = [];
                    Object.entries(wcEvData.games).forEach(function([gameKey, game]) {
                        var away = game.away, home = game.home;
                        var cm = game.cm ? new Date(game.cm) : null;
                        var gid = String(game.id);
                        var pid = gid + '-ta';
                        [[away, 'A', game.away_ml], [home, 'B', game.home_ml]].forEach(function(triple) {
                            var teamName = triple[0], ps = triple[1], am = triple[2];
                            if (am == null) return;
                            wcEvRows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName,
                                am: am, pt: null, pid: pid, ps: ps, gid: gid, league: game.league || '',
                                _sport_key: 'soccer_wc' });
                        });
                    });
                    rawRowsBySport[s.key] = wcEvRows;
                    return;
                }
                if (s.key === 'soccer_fc') {
                    // FC uses FD native DK AH endpoint — not Odds API
                    var fcRes = await fetch('/api/fd/fc', { credentials: 'same-origin' });
                    var fcData = fcRes.ok ? await fcRes.json() : null;
                    if (!fcData || !fcData.ok || !fcData.games) return;
                    var rows = [];
                    Object.entries(fcData.games).forEach(function([gameKey, game]) {
                        var away = game.away, home = game.home;
                        var cm = game.cm ? new Date(game.cm) : null;
                        var gid = String(game.id);
                        var pid = gid + '-h2h';
                        var awayGetsMinus;
                        if (game.awm != null && game.hm != null) { awayGetsMinus = game.awm <= game.hm; }
                        else if (game.awm != null) { awayGetsMinus = true; }
                        else { awayGetsMinus = false; }
                        [[away, 'A'], [home, 'B']].forEach(function(pair) {
                            var teamName = pair[0], ps = pair[1];
                            var isAway = ps === 'A';
                            var isMinus = isAway ? awayGetsMinus : !awayGetsMinus;
                            var initAm = isMinus ? (isAway ? game.awm : game.hm) : (isAway ? game.awp : game.hp);
                            var initPt = isMinus ? -0.5 : 0.5;
                            if (initAm == null) return;
                            rows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'Spread', side: teamName,
                                am: initAm, pt: initPt, pid: pid, ps: ps, gid: gid, league: game.league || '',
                                _sport_key: 'soccer_fc', _dkSpreads: game.spreads || { Home: {}, Away: {} } });
                        });
                    });
                    rawRowsBySport[s.key] = rows;
                    return;
                }
                if (s.key === 'baseball_mlb') {
                    // MLB uses FD native — fetch ML + RFI in parallel
                    var [mlbRes, rfiRes] = await Promise.all([
                        fetch('/api/fd/mlb', { credentials: 'same-origin' }),
                        fetch('/api/fd/rfi', { credentials: 'same-origin' })
                    ]);
                    var mlbData = mlbRes.ok ? await mlbRes.json() : null;
                    var rfiData = rfiRes.ok ? await rfiRes.json() : null;
                    if (!mlbData || !mlbData.ok || !mlbData.games) return;
                    var rows = [];
                    Object.entries(mlbData.games).forEach(function([gameKey, game]) {
                        var away = game.away, home = game.home;
                        var cm = game.cm ? new Date(game.cm) : null;
                        var gid = String(game.id);
                        var pid = gid + '-h2h';
                        [[away, 'A'], [home, 'B']].forEach(function(pair) {
                            var teamName = pair[0], ps = pair[1];
                            var price = game.ml[teamName];
                            if (price == null) return;
                            rows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid });
                        });
                        // Add RFI rows if available
                        if (rfiData && rfiData.ok && rfiData.rfi) {
                            var rfi = rfiData.rfi[gameKey];
                            if (!rfi) {
                                // fuzzy match
                                var fdTeams = gameKey.split(' @ ');
                                var fdAway = (fdTeams[0] || '').toLowerCase();
                                var fdHome = (fdTeams[1] || '').toLowerCase();
                                var matchKey = Object.keys(rfiData.rfi).find(function(k) {
                                    var p = k.split(' @ ');
                                    if (p.length !== 2) return false;
                                    var ka = p[0].toLowerCase(), kh = p[1].toLowerCase();
                                    return ka.split(' ').some(function(w) { return w.length > 2 && fdAway.indexOf(w) !== -1; })
                                        && kh.split(' ').some(function(w) { return w.length > 2 && fdHome.indexOf(w) !== -1; });
                                });
                                if (matchKey) rfi = rfiData.rfi[matchKey];
                            }
                            if (rfi) {
                                var today = new Date(); var dateStr = today.getFullYear() + '' + (today.getMonth()+1) + '' + today.getDate();
                                var rpid = 'rfi-' + gameKey.replace(/[^a-z0-9]/gi, '') + '-' + dateStr;
                                rows.push({ id: rpid + '-A', game: gameKey, cm: cm, mkt: 'RFI', side: 'Yes (YRFI)', am: rfi.yesAm, pt: null, pid: rpid, ps: 'A', gid: gid, rfiFair: rfi.yesFair });
                                rows.push({ id: rpid + '-B', game: gameKey, cm: cm, mkt: 'RFI', side: 'No (NRFI)',  am: rfi.noAm,  pt: null, pid: rpid, ps: 'B', gid: gid, rfiFair: rfi.noFair });
                            }
                        }
                    });
                    rawRowsBySport[s.key] = rows;
                    return;
                }
                if (s.key === 'baseball_cws') {
                    var cwsRes = await fetch('/api/dk/cws', { credentials: 'same-origin' });
                    var cwsData = cwsRes.ok ? await cwsRes.json() : null;
                    if (!cwsData || !cwsData.ok || !cwsData.games) return;
                    var rows = [];
                    Object.entries(cwsData.games).forEach(function([gameKey, game]) {
                        var away = game.away, home = game.home;
                        var cm = game.cm ? new Date(game.cm) : null;
                        var gid = String(game.id);
                        var pid = gid + '-h2h';
                        if (game.awayOdds != null) rows.push({ id: pid + '-A', game: gameKey, cm: cm, mkt: 'ML', side: away, am: game.awayOdds, pt: null, pid: pid, ps: 'A', gid: gid });
                        if (game.homeOdds != null) rows.push({ id: pid + '-B', game: gameKey, cm: cm, mkt: 'ML', side: home, am: game.homeOdds, pt: null, pid: pid, ps: 'B', gid: gid });
                    });
                    rawRowsBySport[s.key] = rows;
                    return;
                }
                if (s.key === 'basketball_nba') {
                    var [nbaRes, nbaSyncEv] = await Promise.all([
                        fetch('/api/fd/nbaalts', { credentials: 'same-origin' }),
                        fetch('/api/real/sync?sport=basketball_nba', { credentials: 'same-origin' })
                    ]);
                    var _nbaSd = nbaSyncEv.ok ? await nbaSyncEv.json() : null;
                    var nbaData = nbaRes.ok ? await nbaRes.json() : null;
                    if (!nbaData || !nbaData.ok || !nbaData.games) return;
                    var rows = [];
                    Object.entries(nbaData.games).forEach(function([gameKey, game]) {
                        var away = game.away, home = game.home;
                        var cm = game.cm ? new Date(game.cm) : null;
                        var gid = String(game.id);
                        if (game.spreads) {
                            var pid = gid + '-spreads';
                            [[away, 'A'], [home, 'B']].forEach(function(pair) {
                                var teamName = pair[0], ps = pair[1];
                                var sideData = game.spreads[teamName];
                                if (!sideData) return;
                                var entry = Object.entries(sideData)[0];
                                if (!entry) return;
                                rows.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'Spread', side: teamName, am: entry[1], pt: parseFloat(entry[0]), pid: pid, ps: ps, gid: gid, _sport_key: 'basketball_nba' });
                            });
                        }
                        if (game.totals) {
                            var pid = gid + '-totals';
                            [['Over','A'],['Under','B']].forEach(function(pair) {
                                var side = pair[0], ps = pair[1];
                                var sideData = game.totals[side];
                                if (!sideData) return;
                                var entry = Object.entries(sideData)[0];
                                if (!entry) return;
                                rows.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'Total', side: side, am: entry[1], pt: parseFloat(entry[0]), pid: pid, ps: ps, gid: gid, _sport_key: 'basketball_nba' });
                            });
                        }
                        if (game.ml) {
                            var pid = gid + '-h2h';
                            [[away,'A'],[home,'B']].forEach(function(pair) {
                                var teamName = pair[0], ps = pair[1];
                                var price = game.ml[teamName];
                                if (price == null) return;
                                rows.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid, _sport_key: 'basketball_nba' });
                            });
                        }
                    });
                    rawRowsBySport[s.key] = rows;
                    freshSyncData[s.key] = _nbaSd;
                    return;
                }
                if (s.key === 'basketball_wnba') {
                    var [wnbaRes, wnbaSyncEv] = await Promise.all([
                        fetch('/api/fd/wnbaalts', { credentials: 'same-origin' }),
                        fetch('/api/real/sync?sport=basketball_wnba', { credentials: 'same-origin' })
                    ]);
                    var _wnbaSd = wnbaSyncEv.ok ? await wnbaSyncEv.json() : null;
                    var wnbaData = wnbaRes.ok ? await wnbaRes.json() : null;
                    if (!wnbaData || !wnbaData.ok || !wnbaData.games) return;
                    var rows = [];
                    Object.entries(wnbaData.games).forEach(function([gameKey, game]) {
                        var away = game.away, home = game.home;
                        var cm = game.cm ? new Date(game.cm) : null;
                        var gid = String(game.id);
                        if (game.ml) {
                            var pid = gid + '-h2h';
                            [[away,'A'],[home,'B']].forEach(function(pair) {
                                var teamName = pair[0], ps = pair[1];
                                var price = game.ml[teamName];
                                if (price == null) return;
                                rows.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid, _sport_key: 'basketball_wnba' });
                            });
                        }
                    });
                    rawRowsBySport[s.key] = rows;
                    freshSyncData[s.key] = _wnbaSd;
                    return;
                }
                if (s.key === 'icehockey_nhl') {
                    var [nhlRes, nhlSyncEv] = await Promise.all([
                        fetch('/api/fd/nhl', { credentials: 'same-origin' }),
                        fetch('/api/real/sync?sport=icehockey_nhl', { credentials: 'same-origin' })
                    ]);
                    var _nhlSd = nhlSyncEv.ok ? await nhlSyncEv.json() : null;
                    var nhlData = nhlRes.ok ? await nhlRes.json() : null;
                    if (!nhlData || !nhlData.ok || !nhlData.games) return;
                    var rows = [];
                    Object.entries(nhlData.games).forEach(function([gameKey, game]) {
                        var away = game.away, home = game.home;
                        var cm = game.cm ? new Date(game.cm) : null;
                        var gid = String(game.id);
                        if (game.spreads) {
                            var pid = gid + '-spreads';
                            [[away,'A'],[home,'B']].forEach(function(pair) {
                                var teamName = pair[0], ps = pair[1];
                                var sideData = game.spreads[teamName];
                                if (!sideData) return;
                                var entry = Object.entries(sideData)[0];
                                if (!entry) return;
                                rows.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'Spread', side: teamName, am: entry[1], pt: parseFloat(entry[0]), pid: pid, ps: ps, gid: gid, _sport_key: 'icehockey_nhl' });
                            });
                        }
                        if (game.totals) {
                            var pid = gid + '-totals';
                            [['Over','A'],['Under','B']].forEach(function(pair) {
                                var side = pair[0], ps = pair[1];
                                var sideData = game.totals[side];
                                if (!sideData) return;
                                var entry = Object.entries(sideData)[0];
                                if (!entry) return;
                                rows.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'Total', side: side, am: entry[1], pt: parseFloat(entry[0]), pid: pid, ps: ps, gid: gid, _sport_key: 'icehockey_nhl' });
                            });
                        }
                        if (game.ml) {
                            var pid = gid + '-h2h';
                            [[away,'A'],[home,'B']].forEach(function(pair) {
                                var teamName = pair[0], ps = pair[1];
                                var price = game.ml[teamName];
                                if (price == null) return;
                                rows.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid, _sport_key: 'icehockey_nhl' });
                            });
                        }
                    });
                    rawRowsBySport[s.key] = rows;
                    freshSyncData[s.key] = _nhlSd;
                    return;
                }
                // MMA and other Odds API sports
                var mkts = noSpread.indexOf(s.key) !== -1 ? 'h2h' : 'h2h,spreads,totals';
                var [resp, syncRespEv] = await Promise.all([
                    fetch('/api/odds?sport=' + s.key + '&markets=' + mkts + '&bookmakers=fanduel'),
                    fetch('/api/real/sync?sport=' + s.key, { credentials: 'same-origin' })
                ]);
                var _mmasd = syncRespEv.ok ? await syncRespEv.json() : null;
                var _remEv = resp.headers.get('x-requests-remaining');
                if (_remEv) { var _remEvEl = document.getElementById('api-remaining'); if (_remEvEl) _remEvEl.textContent = _remEv + ' requests left'; }
                if (!resp.ok) return;
                var d = await resp.json();
                var games = Array.isArray(d) ? d : (d && Array.isArray(d.games) ? d.games : null);
                if (!games) return;
                var savedSport4 = currentSport;
                currentSport = s.key;
                var parsed = parseGames(games);
                currentSport = savedSport4;
                rawRowsBySport[s.key] = parsed;
                freshSyncData[s.key] = _mmasd;
            } catch(e) {}
        }));

        // All parallel fetches done — compute EV for all non-MLB/FC/WC sports
        // Keep evLoadingInProgress=true so there's no partial render before MLB/FC/WC are ready
        sportsToLoad.forEach(function(s) {
            if (s.key === 'baseball_mlb' || s.key === 'soccer_fc' || s.key === 'soccer_wc') return;
            var rows = rawRowsBySport[s.key];
            if (rows && rows.length) computeAndCacheEv(rows, s.key, freshSyncData[s.key] || null);
            done++; updateStatus();
        });

        // MLB, FC, WC: fetch RS sync sequentially (needs global state), then render once for all sports
        try {
            if (rawRowsBySport['baseball_mlb'] && rawRowsBySport['baseball_mlb'].length) {
                var savedSportEv = currentSport, savedRawRowsEv = rawRows;
                currentSport = 'baseball_mlb'; rawRows = rawRowsBySport['baseball_mlb'];
                await fetchRealMarkets('baseball_mlb', true);
                rawRowsBySport['baseball_mlb'] = rawRows;
                rawRows = savedRawRowsEv; currentSport = savedSportEv;
                computeAndCacheEv(rawRowsBySport['baseball_mlb'], 'baseball_mlb', null);
            }
            done++; updateStatus();
            if (rawRowsBySport['soccer_fc'] && rawRowsBySport['soccer_fc'].length) {
                var savedSportEvFc = currentSport, savedRawRowsEvFc = rawRows;
                currentSport = 'soccer_fc'; rawRows = rawRowsBySport['soccer_fc'];
                await fetchRealMarkets('soccer_fc', true);
                rawRowsBySport['soccer_fc'] = rawRows;
                rawRows = savedRawRowsEvFc; currentSport = savedSportEvFc;
                computeAndCacheEv(rawRowsBySport['soccer_fc'], 'soccer_fc', null);
            }
            done++; updateStatus();
            if (rawRowsBySport['soccer_wc'] && rawRowsBySport['soccer_wc'].length) {
                var savedSportEvWc = currentSport, savedRawRowsEvWc = rawRows;
                currentSport = 'soccer_wc'; rawRows = rawRowsBySport['soccer_wc'];
                await fetchRealMarkets('soccer_wc', true);
                rawRowsBySport['soccer_wc'] = rawRows;
                rawRows = savedRawRowsEvWc; currentSport = savedSportEvWc;
                computeAndCacheEv(rawRowsBySport['soccer_wc'], 'soccer_wc', null);
            }
            done++; updateStatus();
        } catch(e) {}
        clearTimeout(_evLoadTimeout);
        evLoadingInProgress = false;
        renderEvTab();
        if (btn) { btn.disabled = false; btn.textContent = '↺ Refresh'; }
        // Start 60s countdown to next auto-refresh in status bar
        var _evCountdown = EV_REFRESH_MS / 1000;
        var _evCountdownTick = setInterval(function() {
            _evCountdown--;
            var st = document.getElementById('ev-load-status');
            if (!st || !evTabVisible) { clearInterval(_evCountdownTick); return; }
            var base = st.textContent.replace(/\s*·.*$/, '');
            st.textContent = base + ' · refresh in ' + _evCountdown + 's';
            if (_evCountdown <= 0) clearInterval(_evCountdownTick);
        }, 1000);
    }

    async function disconnectRealSports() {
        showConfirm('Disconnect your Real Sports account from RaxEdge?', async function() { await _doDisconnectRealSports(); });
        return;
    }
    async function _doDisconnectRealSports() {
        try {
            await fetch('/api/real/connect', { method: 'DELETE', credentials: 'same-origin' });
        } catch(e) {}
        try { posthog.capture('rs_disconnected'); } catch(e) {}
        portfolioConnected = false;
        portHistoryAll = []; portHistoryCursor = null; portHistoryMore = false;
        try { localStorage.removeItem(PORT_CACHE_KEY); } catch(e) {}
        document.getElementById('portfolio-data-view').style.display = 'none';
        document.getElementById('portfolio-connect-view').style.display = '';
        document.getElementById('port-refresh-btn').style.display = 'none';
        document.getElementById('port-disconnect-btn').style.display = 'none';
    }

    async function loadPortfolio(forceRefresh) {
        try {
            // If redirected back from bookmarklet, save the token first then fall through to fetch
            var pendingToken = sessionStorage.getItem('pending_rs_token');
            if (pendingToken) {
                var pendingUuid = sessionStorage.getItem('pending_rs_uuid') || '';
                sessionStorage.removeItem('pending_rs_token');
                sessionStorage.removeItem('pending_rs_uuid');
                var connRes = await fetch('/api/real/connect', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ auth_token: pendingToken, device_uuid: pendingUuid })
                });
                var connData = await connRes.json();
                if (!connData.ok) {
                    showToast('Failed to save Real Sports token: ' + (connData.error || 'Unknown error'), 'error');
                    return;
                }
                portfolioConnected = true;
                try { posthog.capture('rs_connected'); } catch(e) {}
                // Fall through — continue to fetch and render portfolio below
            }

            var connectView = document.getElementById('portfolio-connect-view');
            var dataView    = document.getElementById('portfolio-data-view');
            var loadingEl   = document.getElementById('portfolio-loading');
            var contentEl   = document.getElementById('portfolio-content');

            connectView.style.display = 'none';
            dataView.style.display = '';

            // Restore from cache immediately — content appears without waiting for API
            var cache = !forceRefresh ? loadHistoryCache() : null;
            if (cache && cache.items && cache.items.length) {
                // Deduplicate cached items (cache may have been saved with dupes)
                var _cSeenIds = new Set();
                portHistoryAll = cache.items.filter(function(p){ return _cSeenIds.has(p.id) ? false : (_cSeenIds.add(p.id), true); });
                portHistoryCursor = cache.cursor;
                portHistoryMore   = cache.hasMore;
                portSelectedDate  = localDateKey(new Date());
                var _di = document.getElementById('port-date-filter');
                if (_di) _di.value = portSelectedDate;
                loadingEl.style.display = 'none';
                contentEl.style.display = '';
                portfolioConnected = true;
                document.getElementById('port-refresh-btn').style.display = '';
                document.getElementById('port-disconnect-btn').style.display = '';
                updatePortProfit();
                renderHistoryForDate(portSelectedDate);
                portCalYear  = new Date().getFullYear();
                portCalMonth = new Date().getMonth();
                renderCalendar();
            } else {
                loadingEl.style.display = '';
                contentEl.style.display = 'none';
            }

            // Fetch fresh data (perf, open positions, and page 1 of history for new bets)
            var res = await fetch('/api/real/portfolio?timeframe=' + portTimeframe, { credentials: 'same-origin' });
            var data = await res.json();

            loadingEl.style.display = 'none';

            if (!data.connected) {
                connectView.style.display = '';
                dataView.style.display = 'none';
                document.getElementById('port-refresh-btn').style.display = 'none';
                document.getElementById('port-disconnect-btn').style.display = 'none';
                return;
            }

            portfolioConnected = true;
            document.getElementById('port-refresh-btn').style.display = '';
            document.getElementById('port-disconnect-btn').style.display = '';
            contentEl.style.display = '';

            // Show/hide the public-only upgrade banner
            var pubBanner = document.getElementById('port-public-banner');
            if (pubBanner) pubBanner.style.display = data.publicOnly ? 'flex' : 'none';

            // Merge fresh page 1: prepend any bets not already in cache
            if (cache && cache.items && cache.items.length) {
                var freshItems = (data.history && data.history.items) || [];
                var existingIds = new Set(portHistoryAll.map(function(p){ return p.id; }));
                var newItems = freshItems.filter(function(p){ return !existingIds.has(p.id); });
                if (newItems.length) portHistoryAll = newItems.concat(portHistoryAll);
                data._historyMerged = true; // signal renderPortfolio to skip overwriting history state
            }

            renderPortfolio(data);

        } catch(e) {
            var loadingEl = document.getElementById('portfolio-loading');
            if (loadingEl) loadingEl.textContent = 'Error loading portfolio: ' + e.message;
        }
    }

    function renderPortfolio(data) {
        var summary = (data.performance && data.performance.summary) || {};
        var perfHistory = (data.performance && data.performance.history) || [];
        var openPos  = (data.open && data.open.positions) || [];
        var histItems = (data.history && data.history.items) || [];

        var activePos = openPos.filter(function(p) { return !p.isSettled; });
        document.getElementById('port-open-count').textContent = activePos.length;


        // --- Build gameId → rawRows map for edge matching ---
        var gidToRows = {};
        Object.keys(rsGameIds || {}).forEach(function(gameKey) {
            var gid = String(rsGameIds[gameKey]);
            if (!gidToRows[gid]) gidToRows[gid] = [];
            (rawRows || []).forEach(function(r) {
                if (r.game === gameKey) gidToRows[gid].push(r);
            });
        });

        // Build gid → commenceTime from all cached sports + RS sync startMs
        // RS startMs is the most reliable fallback: it's still present even after FD drops resulted games
        var allCachedRows = Object.values(rawRowsBySport || {}).reduce(function(acc, sr) { return acc.concat(sr || []); }, rawRows || []);
        var gidToCm = {};
        Object.keys(rsGameIds || {}).forEach(function(gameKey) {
            var gid = String(rsGameIds[gameKey]);
            if (gidToCm[gid]) return;
            var row = allCachedRows.find(function(r) { return r.game === gameKey && r.cm; });
            if (row) { gidToCm[gid] = row.cm; return; }
            var startMs = rsGameStartMs[gameKey];
            if (startMs) gidToCm[gid] = new Date(startMs);
        });

        // marketType → mkt normalisation
        var mktMap = { gamewinner: 'ML', pointspread: 'Spread', total: 'Total', moneyline: 'ML' };

        // strip trailing probability from outcomeLabel e.g. "GSW +4.5 99%" → "GSW +4.5"
        function stripProb(s) { return (s || '').replace(/\s+\d+%$/, ''); }

        // --- Open positions ---
        var openHead = document.querySelector('#port-open-tbody').closest('table').querySelector('thead tr');
        if (openHead) openHead.innerHTML = '<th>Matchup</th><th>Sport</th><th>Market</th><th>Side</th><th class="r">Avg</th><th class="r">Now</th><th class="r">Cost</th><th class="r">Pays</th><th>Status</th>';

        var openTbody = document.getElementById('port-open-tbody');
        var openStats = document.getElementById('port-open-stats');
        if (!isPro()) {
            if (openStats) openStats.style.display = 'none';
            // Replace table with a clean pro gate (no table rows — avoids mobile card layout issues)
            var openWrap = openTbody.closest('.admin-table-wrap');
            if (openWrap) {
                openWrap.innerHTML = '<div onclick="showUpgradeModal(\'Open Positions requires Pro. Upgrade to track your live positions and current market values.\')" '
                    + 'style="position:relative;border-radius:8px;overflow:hidden;cursor:pointer;min-height:100px">'
                    + '<div style="filter:blur(4px);pointer-events:none;user-select:none;padding:14px 16px">'
                    + '<div style="height:12px;background:var(--bg3);border-radius:3px;margin-bottom:10px;width:70%"></div>'
                    + '<div style="height:12px;background:var(--bg3);border-radius:3px;margin-bottom:10px;width:50%"></div>'
                    + '<div style="height:12px;background:var(--bg3);border-radius:3px;width:60%"></div>'
                    + '</div>'
                    + '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:rgba(10,10,12,.55)">'
                    + '<span style="font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.1em;padding:5px 16px;border-radius:20px;background:var(--accent);color:#fff">PRO FEATURE</span>'
                    + '<span style="font-size:12px;color:var(--muted);text-align:center">Upgrade to see open positions</span>'
                    + '</div>'
                    + '</div>';
            }
        } else if (!activePos.length) {
            if (openStats) openStats.style.display = 'none';
            openTbody.innerHTML = '<tr><td colspan="9" style="color:var(--muted);padding:20px 12px">No open positions</td></tr>';
        } else {
            var rows = activePos.map(function(p) {
                var matchup  = (p.marketDisplay && p.marketDisplay.display) || '—';
                var market   = p.marketLabel || mktMap[p.marketType] || p.marketType || '—';
                var side     = stripProb(p.outcomeLabel) || '—';
                var gid      = p.gameId != null ? String(p.gameId) : null;
                var details  = Array.isArray(p.details) ? p.details : [];
                var avg      = (details.find(function(d){ return d.label==='Avg';  }) || {}).display || '—';
                var cost     = (details.find(function(d){ return d.label==='Cost'; }) || {}).display || '—';
                var pays     = (details.find(function(d){ return d.label==='Pays'; }) || {}).display || '—';
                var cur      = p.currentPriceDisplay || '—';
                var status   = p.leftFooterText || '—';

                // Sport label: try sportId numeric map, then sport string, then sportLabel
                var sportLbl = '—';
                if (p.sportId && REAL_SPORT_LABELS[p.sportId]) {
                    sportLbl = REAL_SPORT_LABELS[p.sportId];
                } else if (p.sport) {
                    // may be a key like "nba" or a label like "NBA"
                    sportLbl = REAL_SPORT_LABELS[REAL_SPORT_IDS[p.sport.toLowerCase()]] || p.sport.toUpperCase();
                } else if (p.sportLabel) {
                    sportLbl = p.sportLabel;
                }

                // Edge match: normalise marketType to our mkt labels
                var mktNorm  = (mktMap[p.marketType] || '').toLowerCase();
                var matchedRow = gid && gidToRows[gid] ? gidToRows[gid].find(function(r) {
                    return r.mkt && r.mkt.toLowerCase() === mktNorm;
                }) : null;
                var edgeBadge = matchedRow && matchedRow.edge != null
                    ? '<span class="port-match-badge">' + (matchedRow.edge > 0 ? '+' : '') + matchedRow.edge.toFixed(1) + '% edge</span>'
                    : '';

                // Gradient based on Now% vs Avg% — green = price went up (winning), red = down
                var nowPct = parseFloat(String(cur).replace(/[^0-9.]/g, ''));
                var avgPct = parseFloat(String(avg).replace(/[^0-9.]/g, ''));
                var trStyle = '';
                if (!isNaN(nowPct) && !isNaN(avgPct)) {
                    var diff = nowPct - avgPct;
                    var intensity = Math.min(Math.abs(diff) / 20, 1);
                    if (diff > 0) {
                        var ga = (intensity * 0.22).toFixed(3);
                        var gb = (intensity * 0.4).toFixed(3);
                        trStyle = 'background:linear-gradient(145deg,rgba(45,204,126,' + ga + ') 0%,var(--bg2) 100%);border-color:rgba(45,204,126,' + gb + ')';
                    } else if (diff < 0) {
                        var ra = (intensity * 0.22).toFixed(3);
                        var rb = (intensity * 0.4).toFixed(3);
                        trStyle = 'background:linear-gradient(145deg,rgba(240,82,82,' + ra + ') 0%,var(--bg2) 100%);border-color:rgba(240,82,82,' + rb + ')';
                    }
                }

                var portGameUrl = getPortfolioGameUrl(p);
                var portGameLink = portGameUrl ? ' <a href="' + portGameUrl + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--accent);font-size:11px;text-decoration:none;opacity:0.85" title="View on Real Sports">&#8599;</a>' : '';

                var isLivePos = false;
                var posCm = (matchedRow && matchedRow.cm) || (gid && gidToCm[gid]) || null;
                if (posCm) {
                    isLivePos = posCm.getTime() <= Date.now();
                } else {
                    var statusLower = (status || '').toLowerCase();
                    isLivePos = statusLower.indexOf('progress') !== -1 || statusLower.indexOf('live') !== -1;
                }
                var liveDot = isLivePos ? '<span class="live-dot" style="display:inline-block;margin-right:5px;vertical-align:middle"></span>' : '';

                return '<tr' + (trStyle ? ' style="' + trStyle + '"' : '') + '>'
                    + '<td data-label="Matchup">' + liveDot + escHtml(matchup) + portGameLink + '</td>'
                    + '<td data-label="Sport" style="font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--muted)">' + escHtml(sportLbl) + '</td>'
                    + '<td data-label="Market"><span class="mkt-badge">' + escHtml(market) + '</span></td>'
                    + '<td data-label="Side">' + escHtml(side) + edgeBadge + '</td>'
                    + '<td data-label="Avg" class="r" style="font-family:var(--mono);color:var(--muted)">' + escHtml(avg) + '</td>'
                    + '<td data-label="Now" class="r" style="font-family:var(--mono);color:var(--muted)">' + escHtml(cur) + '</td>'
                    + '<td data-label="Cost" class="r" style="font-family:var(--mono)">' + escHtml(cost) + '</td>'
                    + '<td data-label="Pays" class="r" style="font-family:var(--mono);color:var(--green)">' + escHtml(pays) + '</td>'
                    + '<td data-label="Status" style="color:var(--muted);font-size:11px">' + escHtml(status) + '</td>'
                    + '</tr>';
            });
            var OPEN_PREVIEW = 3;
            var showAllOpen  = false;
            function renderOpenRows() {
                var visible = showAllOpen ? rows : rows.slice(0, OPEN_PREVIEW);
                openTbody.innerHTML = visible.join('');
                var btnEl = document.getElementById('port-open-show-all-btn');
                if (btnEl) {
                    if (rows.length <= OPEN_PREVIEW) { btnEl.style.display = 'none'; return; }
                    btnEl.style.display = '';
                    btnEl.textContent = showAllOpen ? 'Show Less ▲' : 'Show All (' + rows.length + ') ▼';
                }
            }
            renderOpenRows();
            var showAllBtn = document.getElementById('port-open-show-all-btn');
            if (!showAllBtn) {
                showAllBtn = document.createElement('button');
                showAllBtn.id = 'port-open-show-all-btn';
                showAllBtn.style.cssText = 'display:none;margin-top:8px;background:var(--bg3);border:1px solid var(--border2);color:var(--muted);font-family:var(--sans);font-size:11px;font-weight:600;padding:5px 14px;border-radius:5px;cursor:pointer;width:100%';
                var openTableWrap = openTbody.closest('.admin-table-wrap');
                if (openTableWrap && openTableWrap.parentNode) openTableWrap.parentNode.insertBefore(showAllBtn, openTableWrap.nextSibling);
            }
            showAllBtn.onclick = function() { showAllOpen = !showAllOpen; renderOpenRows(); };
            if (rows.length > OPEN_PREVIEW) { showAllBtn.style.display = ''; showAllBtn.textContent = 'Show All (' + rows.length + ') ▼'; }

            // Summary stats above open positions
            if (openStats && activePos.length) {
                var totalCost = 0, totalPays = 0;
                activePos.forEach(function(p) {
                    var det = Array.isArray(p.details) ? p.details : [];
                    totalCost += parseRaxDisplay((det.find(function(d){ return d.label==='Cost'; }) || {}).display);
                    totalPays += parseRaxDisplay((det.find(function(d){ return d.label==='Pays'; }) || {}).display);
                });
                var maxProfit = totalPays - totalCost;
                var unitSize  = parseFloat(localStorage.getItem('raxedge_unit_size') || '300') || 300;
                var unitsOut  = totalCost / unitSize;
                var statStyle = 'flex:1;min-width:110px;background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:10px 14px';
                openStats.style.display = 'flex';
                openStats.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px';
                openStats.innerHTML =
                    '<div style="' + statStyle + '">'
                    +   '<div style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);margin-bottom:4px">Invested</div>'
                    +   '<div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--fg)">' + RAX_ICON + fmtRax(totalCost) + '</div>'
                    + '</div>'
                    + '<div style="' + statStyle + '">'
                    +   '<div style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);margin-bottom:4px">Max Win</div>'
                    +   '<div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--green)">' + RAX_ICON + fmtRax(totalPays) + '</div>'
                    + '</div>'
                    + '<div style="' + statStyle + '">'
                    +   '<div style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);margin-bottom:4px">Max Profit</div>'
                    +   '<div style="font-family:var(--mono);font-size:15px;font-weight:700;color:' + (maxProfit >= 0 ? 'var(--green)' : 'var(--red)') + '">' + RAX_ICON + (maxProfit >= 0 ? '+' : '') + fmtRax(maxProfit) + '</div>'
                    + '</div>'
                    + '<div style="' + statStyle + '">'
                    +   '<div style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);margin-bottom:4px">Units Out</div>'
                    +   '<div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--fg)">' + unitsOut.toFixed(2) + 'u <span style="font-size:10px;color:var(--muted)">@ $' + Math.round(unitSize) + '</span></div>'
                    + '</div>';
            } else if (openStats) {
                openStats.style.display = 'none';
            }
        }

        // Update history state — skip if we merged from cache (state already set)
        if (!data._historyMerged) {
            // Deduplicate by id in case RS API returns overlapping items
            var _seenIds = new Set();
            portHistoryAll = histItems.filter(function(p){ return _seenIds.has(p.id) ? false : (_seenIds.add(p.id), true); });
            portHistoryCursor = histItems.length
                ? (histItems[histItems.length - 1].latestLedgerTimestamp || histItems[histItems.length - 1].transactedAt)
                : null;
            portHistoryMore   = !!(data.history && data.history.hasMore);
        }

        document.getElementById('port-settled-count').textContent = portHistoryAll.length + (portHistoryMore ? '+' : '');

        // Default date filter to today, set input value
        portSelectedDate = localDateKey(new Date());
        var dateInput = document.getElementById('port-date-filter');
        if (dateInput) {
            dateInput.value = portSelectedDate;
            // Free users: lock date picker to last 7 days only
            if (!isPro()) {
                var minDate = localDateKey(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
                dateInput.min = minDate;
                dateInput.max = portSelectedDate;
            } else {
                dateInput.min = '';
                dateInput.max = '';
            }
        }

        updatePortProfit();
        updatePerfCards();
        updatePortFilterOptions();
        renderHistoryForDate(portSelectedDate);

        // Init calendar to current month and render
        portCalYear  = new Date().getFullYear();
        portCalMonth = new Date().getMonth();
        renderCalendar();

        // Auto-load all remaining history pages in background, then save to cache
        autoLoadAllHistory();

        document.getElementById('port-debug').style.display = 'none';
    }

    function parseRaxDisplay(s) {
        // "1,074" → 1074, "807" → 807, "0" → 0
        if (s == null) return 0;
        return parseFloat(String(s).replace(/,/g, '')) || 0;
    }

    // ── History item helpers ──────────────────────────────────────────
    // headerLabel format is "NBA Game Winner", "MLB Total", "NHL Spread", etc.
    // Sport is always the first word.
    var KNOWN_SPORTS_LIST = null;
    function getHistSport(p) {
        if (!KNOWN_SPORTS_LIST) KNOWN_SPORTS_LIST = Object.values(REAL_SPORT_LABELS);
        var header = String(p.headerLabel || p.marketLabel || '');
        // First word of headerLabel is the sport (e.g. "NBA" from "NBA Game Winner")
        var firstWord = header.split(' ')[0].toUpperCase();
        if (firstWord && KNOWN_SPORTS_LIST.indexOf(firstWord) !== -1) return firstWord;
        if (firstWord === 'FC') return 'Soccer'; // RS labels soccer bets as "FC Spread"
        // Also scan full string in case format varies
        for (var j = 0; j < KNOWN_SPORTS_LIST.length; j++) {
            if (header.toUpperCase().indexOf(KNOWN_SPORTS_LIST[j].toUpperCase()) !== -1) return KNOWN_SPORTS_LIST[j];
        }
        // Fallback: direct sport fields
        if (p.sportId && REAL_SPORT_LABELS[p.sportId]) return REAL_SPORT_LABELS[p.sportId];
        return '';
    }
    function getHistMarket(p) {
        var raw = p.headerLabel || p.marketLabel || p.marketType || '';
        if (!KNOWN_SPORTS_LIST) KNOWN_SPORTS_LIST = Object.values(REAL_SPORT_LABELS);
        // Strip leading sport prefix (e.g. "NBA Game Winner" → "Game Winner")
        for (var j = 0; j < KNOWN_SPORTS_LIST.length; j++) {
            var prefix = KNOWN_SPORTS_LIST[j] + ' ';
            if (raw.toUpperCase().indexOf(prefix.toUpperCase()) === 0) return raw.slice(prefix.length).trim();
        }
        return raw;
    }
    function getHistResult(p) {
        var details = Array.isArray(p.details) ? p.details : [];
        var costDet = details.find(function(d){ return d.label === 'Cost'; }) || {};
        var paidDet = details.find(function(d){ return d.label === 'Paid'; }) || {};
        var paidNum = parseRaxDisplay(paidDet.display);
        var costNum = parseRaxDisplay(costDet.display);
        var isGreenWin = paidDet.color === 'green' && paidNum > 0;
        if (isGreenWin && paidNum >= costNum) return 'win';
        if (isGreenWin && paidNum < costNum)  return 'cashout'; // early cashout — lost money
        if (paidDet.display === '0' || paidDet.color === 'default') return 'loss';
        return '';
    }
    function getHistProfit(p) {
        var details = Array.isArray(p.details) ? p.details : [];
        var cost = parseRaxDisplay((details.find(function(d){ return d.label==='Cost'; }) || {}).display);
        var paid = parseRaxDisplay((details.find(function(d){ return d.label==='Paid'; }) || {}).display);
        return paid - cost;
    }

    // Known sports whitelist — prevents prop market names leaking into sport filter
    var KNOWN_SPORTS = (function() {
        var s = {};
        Object.values(REAL_SPORT_LABELS).forEach(function(v){ s[v] = 1; });
        return s;
    }());

    function applyPortFilters() {
        portFilterSport  = (document.getElementById('port-filter-sport')  || {}).value || '';
        portFilterMarket = (document.getElementById('port-filter-market') || {}).value || '';
        portFilterResult = (document.getElementById('port-filter-result') || {}).value || '';
        portSortBy       = (document.getElementById('port-sort-by')       || {}).value || 'chrono-desc';
        renderHistoryForDate(portSelectedDate);
    }

    function togglePortAllTime() {
        if (!isPro()) {
            showUpgradeModal('Upgrade to Pro to view your complete all-time betting history.');
            return;
        }
        portShowAllTime = !portShowAllTime;
        var btn        = document.getElementById('port-alltime-btn');
        var datePicker = document.getElementById('port-date-filter');
        if (btn)        btn.classList.toggle('port-tf-active', portShowAllTime);
        if (datePicker) datePicker.style.opacity = portShowAllTime ? '0.3' : '1';
        if (datePicker) datePicker.style.pointerEvents = portShowAllTime ? 'none' : '';
        renderHistoryForDate(portSelectedDate);
    }

    function onPortSportChange() {
        var sportSel  = document.getElementById('port-filter-sport');
        var marketSel = document.getElementById('port-filter-market');
        if (!sportSel || !marketSel) return;
        var sport = sportSel.value;
        if (!sport) {
            // All Sports — hide market filter, reset it
            marketSel.style.display = 'none';
            marketSel.value = '';
            portFilterMarket = '';
        } else {
            // Build market options for this sport only
            var markets = {};
            portHistoryAll.forEach(function(p) {
                if (getHistSport(p) !== sport) return;
                var m = getHistMarket(p); if (m) markets[m] = 1;
            });
            var prevMarket = marketSel.value;
            marketSel.innerHTML = '<option value="">All Markets</option>'
                + Object.keys(markets).sort().map(function(m){
                    return '<option value="' + escHtml(m) + '"' + (m===prevMarket?' selected':'') + '>' + escHtml(m) + '</option>';
                }).join('');
            marketSel.style.display = '';
        }
        applyPortFilters();
    }

    function updatePortFilterOptions() {
        var sports = {};
        portHistoryAll.forEach(function(p) {
            var s = getHistSport(p);
            if (s) sports[s] = 1;
        });
        var sportSel = document.getElementById('port-filter-sport');
        if (sportSel) {
            var cur = sportSel.value;
            sportSel.innerHTML = '<option value="">All Sports</option>'
                + Object.keys(sports).sort().map(function(s){
                    return '<option value="' + escHtml(s) + '"' + (s===cur?' selected':'') + '>' + escHtml(s) + '</option>';
                }).join('');
            // Re-sync market dropdown if a sport was selected
            if (cur) onPortSportChange();
        }
    }

    function buildDailyMap(items) {
        var map = {};
        items.forEach(function(p) {
            if (!p.transactedAt) return;
            var dateKey = localDateKey(p.transactedAt);
            if (!map[dateKey]) map[dateKey] = { pnl: 0, bets: 0 };
            var details = Array.isArray(p.details) ? p.details : [];
            var cost = parseRaxDisplay((details.find(function(d){ return d.label==='Cost'; }) || {}).display);
            var paid = parseRaxDisplay((details.find(function(d){ return d.label==='Paid'; }) || {}).display);
            map[dateKey].pnl  += paid - cost;
            map[dateKey].bets += 1;
        });
        return map;
    }

    function renderCalendar() {
        var calEl = document.getElementById('port-calendar');
        if (!calEl) return;
        var label = document.getElementById('port-cal-label');
        var nextBtn = document.getElementById('port-cal-next');
        var today = new Date();
        var now = new Date(portCalYear, portCalMonth, 1);
        var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        if (label) label.textContent = monthNames[portCalMonth] + ' ' + portCalYear;
        // Disable next if at current month
        if (nextBtn) nextBtn.disabled = (portCalYear === today.getFullYear() && portCalMonth === today.getMonth());

        var dailyMap = buildDailyMap(portHistoryAll);

        // Monthly total
        var monthTotal = 0;
        var mm = String(portCalMonth + 1).padStart(2, '0');
        Object.keys(dailyMap).forEach(function(k) {
            if (k.startsWith(portCalYear + '-' + mm)) monthTotal += dailyMap[k].pnl;
        });
        var monthTotalEl = document.getElementById('port-cal-monthly-total');
        if (monthTotalEl) {
            var mUnit    = parseFloat(localStorage.getItem('raxedge_unit_size') || '300') || 300;
            var mUnitStr = (monthTotal / mUnit);
            var totalStr = RAX_ICON + (monthTotal >= 0 ? '+' : '') + fmtRax(monthTotal) + ' (' + (mUnitStr >= 0 ? '+' : '') + mUnitStr.toFixed(2) + 'u)';
            var totalColor = monthTotal > 0 ? 'var(--green)' : monthTotal < 0 ? 'var(--red)' : 'var(--muted)';
            if (!isPro()) {
                monthTotalEl.innerHTML = '<span style="filter:blur(6px);user-select:none;cursor:pointer" onclick="showUpgradeModal(\'Upgrade to Pro to see your monthly P&amp;L totals.\')">' + totalStr + '</span>';
                monthTotalEl.style.color = totalColor;
            } else {
                monthTotalEl.innerHTML = totalStr;
                monthTotalEl.style.color = totalColor;
            }
        }

        var daysInMonth = new Date(portCalYear, portCalMonth + 1, 0).getDate();
        var firstDow = new Date(portCalYear, portCalMonth, 1).getDay(); // 0=Sun

        // Find max |pnl| this month for intensity scaling
        var maxAbsPnl = 0;
        for (var di = 1; di <= daysInMonth; di++) {
            var dkey = portCalYear + '-' + String(portCalMonth+1).padStart(2,'0') + '-' + String(di).padStart(2,'0');
            if (dailyMap[dkey]) maxAbsPnl = Math.max(maxAbsPnl, Math.abs(dailyMap[dkey].pnl));
        }

        var html = '<div class="port-cal">';
        // Day-of-week headers
        ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(function(d) {
            html += '<div class="port-cal-hdr">' + d + '</div>';
        });
        // Empty cells before first day
        for (var i = 0; i < firstDow; i++) {
            html += '<div class="port-cal-day empty"></div>';
        }
        // Day cells
        for (var d = 1; d <= daysInMonth; d++) {
            var mm = String(portCalMonth + 1).padStart(2, '0');
            var dd = String(d).padStart(2, '0');
            var key = portCalYear + '-' + mm + '-' + dd;
            var dayData = dailyMap[key];
            var isToday = (portCalYear === today.getFullYear() && portCalMonth === today.getMonth() && d === today.getDate());
            var freeCutoff = localDateKey(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
            var isBlurred = !isPro() && key < freeCutoff;
            var cls = 'port-cal-day' + (isToday ? ' today' : '') + (dayData ? ' has-data' : '');
            var pnlHtml = '';
            var dayStyle = '';
            if (dayData) {
                var pnl = dayData.pnl;
                var pnlColor = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--muted)';
                var calUnit  = parseFloat(localStorage.getItem('raxedge_unit_size') || '300') || 300;
                var calUnitStr = (pnl / calUnit);
                var pnlAmtStr  = (pnl > 0 ? '+' : '') + fmtRax(pnl);
                var pnlUnitStr = (calUnitStr >= 0 ? '+' : '') + calUnitStr.toFixed(1) + 'u';
                if (isBlurred) {
                    pnlHtml = '<span class="port-cal-pnl" style="filter:blur(5px);color:' + pnlColor + '">' + pnlAmtStr + '</span>'
                            + '<span class="port-cal-unit" style="filter:blur(3px)">' + pnlUnitStr + '</span>'
                            + '<span class="port-cal-bets" style="filter:blur(3px)">' + dayData.bets + ' bet' + (dayData.bets !== 1 ? 's' : '') + '</span>';
                } else {
                    pnlHtml = '<span class="port-cal-pnl" style="color:' + pnlColor + '">' + pnlAmtStr + '</span>'
                            + '<span class="port-cal-unit" style="color:' + pnlColor + '">' + pnlUnitStr + '</span>'
                            + '<span class="port-cal-bets">' + dayData.bets + ' bet' + (dayData.bets !== 1 ? 's' : '') + '</span>';
                    // Gradient intensity: scale from 0.08 (small) → 0.45 (max)
                    if (maxAbsPnl > 0 && pnl !== 0) {
                        var intensity = Math.min(Math.abs(pnl) / maxAbsPnl, 1);
                        var alpha = (0.08 + intensity * 0.37).toFixed(3);
                        if (pnl > 0) dayStyle = 'background:rgba(45,204,126,' + alpha + ');border-color:rgba(45,204,126,' + (intensity*0.5).toFixed(3) + ')';
                        else         dayStyle = 'background:rgba(240,82,82,' + alpha + ');border-color:rgba(240,82,82,' + (intensity*0.5).toFixed(3) + ')';
                    }
                }
            }
            var dayAttrs;
            if (isBlurred && dayData) {
                dayAttrs = ' onclick="showUpgradeModal(\'Upgrade to Pro to unlock your full P&amp;L calendar.\')" style="cursor:pointer"';
            } else {
                dayAttrs = (dayData ? ' onclick="selectCalDay(\'' + key + '\')"' : '');
                if (dayStyle) dayAttrs += ' style="cursor:pointer;' + dayStyle + '"';
                else if (dayData) dayAttrs += ' style="cursor:pointer"';
            }
            html += '<div class="' + cls + '" title="' + key + '"' + dayAttrs + '>'
                  + '<span class="port-cal-dn">' + d + '</span>'
                  + pnlHtml
                  + '</div>';
        }
        html += '</div>';
        calEl.innerHTML = html;
    }

    function calcPerfForPeriod(days) {
        var cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        var totalCost = 0, totalPaid = 0, count = 0;
        portHistoryAll.forEach(function(p) {
            if (!p.transactedAt || new Date(p.transactedAt).getTime() < cutoff) return;
            var details = Array.isArray(p.details) ? p.details : [];
            var cost = parseRaxDisplay((details.find(function(d){ return d.label==='Cost'; }) || {}).display);
            var paid = parseRaxDisplay((details.find(function(d){ return d.label==='Paid'; }) || {}).display);
            totalCost += cost; totalPaid += paid; count++;
        });
        var pnl = totalPaid - totalCost;
        var roi = totalCost > 0 ? (pnl / totalCost * 100) : 0;
        return { pnl: pnl, roi: roi, count: count };
    }

    function updatePerfCards() {
        var days = portTimeframe === '1w' ? 7 : portTimeframe === '3m' ? 90 : 30;
        var calc = calcPerfForPeriod(days);
        var cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        var wins = 0, total = 0;
        portHistoryAll.forEach(function(p) {
            if (!p.transactedAt || new Date(p.transactedAt).getTime() < cutoff) return;
            total++;
            if (getHistResult(p) === 'win') wins++;
        });
        var winRate = total > 0 ? (wins / total * 100) : 0;
        var pnlEl = document.getElementById('port-pnl');
        var roiEl = document.getElementById('port-roi');
        var wrEl  = document.getElementById('port-winrate');
        if (pnlEl) { pnlEl.innerHTML = RAX_ICON + (calc.pnl >= 0 ? '+' : '') + fmtRax(calc.pnl); pnlEl.style.color = calc.pnl >= 0 ? 'var(--green)' : 'var(--red)'; }
        if (!isPro()) {
            if (roiEl) { roiEl.innerHTML = '<span style="filter:blur(5px);user-select:none">' + (calc.roi >= 0 ? '+' : '') + calc.roi.toFixed(1) + '%</span>'; roiEl.style.color = calc.roi >= 0 ? 'var(--green)' : 'var(--red)'; roiEl.style.cursor = 'pointer'; roiEl.onclick = function(){ showUpgradeModal('ROI tracking requires Pro.'); }; }
            if (wrEl)  { wrEl.innerHTML  = '<span style="filter:blur(5px);user-select:none">' + winRate.toFixed(1) + '%</span>'; wrEl.style.color = winRate >= 50 ? 'var(--green)' : 'var(--red)'; wrEl.style.cursor = 'pointer'; wrEl.onclick = function(){ showUpgradeModal('Win Rate tracking requires Pro.'); }; }
        } else {
            if (roiEl) { roiEl.textContent = (calc.roi >= 0 ? '+' : '') + calc.roi.toFixed(1) + '%'; roiEl.style.color = calc.roi >= 0 ? 'var(--green)' : 'var(--red)'; roiEl.style.cursor = ''; roiEl.onclick = null; }
            if (wrEl)  { wrEl.textContent = winRate.toFixed(1) + '%'; wrEl.style.color = winRate >= 50 ? 'var(--green)' : 'var(--red)'; wrEl.style.cursor = ''; wrEl.onclick = null; }
        }
    }

    function setPortTimeframe(tf) {
        if (!isPro() && tf !== '1w') {
            showUpgradeModal('Upgrade to Pro to unlock 1-month and 3-month performance views.');
            return;
        }
        portTimeframe = tf;
        ['1w','1m','3m'].forEach(function(t) {
            var btn = document.getElementById('port-tf-' + t);
            if (btn) btn.classList.toggle('port-tf-active', t === tf);
        });
        updatePerfCards();
    }

    function selectCalDay(dateKey) {
        portSelectedDate = dateKey;
        var dateInput = document.getElementById('port-date-filter');
        if (dateInput) dateInput.value = dateKey;
        renderHistoryForDate(dateKey);
        // Scroll history table into view
        var histEl = document.getElementById('port-history-tbody');
        if (histEl) histEl.closest('table').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function shiftCalMonth(delta) {
        portCalMonth += delta;
        if (portCalMonth > 11) { portCalMonth = 0; portCalYear++; }
        if (portCalMonth < 0)  { portCalMonth = 11; portCalYear--; }
        renderCalendar();
    }

    async function loadMoreHistory() {
        if (!portHistoryMore || !portHistoryCursor) return false;
        try {
            var fetchUrl = '/api/real/portfolio?before=' + encodeURIComponent(portHistoryCursor);
            var res = await fetch(fetchUrl, { credentials: 'same-origin' });
            var data = await res.json();
            var newItems = (data.history && data.history.items) || [];
            var existingIds = new Set(portHistoryAll.map(function(p){ return p.id; }));
            var dedupedNew = newItems.filter(function(p){ return !existingIds.has(p.id); });
            portHistoryAll    = portHistoryAll.concat(dedupedNew);
            portHistoryCursor = newItems.length
                ? (newItems[newItems.length - 1].latestLedgerTimestamp || newItems[newItems.length - 1].transactedAt)
                : null;
            portHistoryMore   = !!(data.history && data.history.hasMore);
            return true;
        } catch(e) {
            return false;
        }
    }

    async function autoLoadAllHistory() {
        var statusEl = document.getElementById('port-load-status');
        while (portHistoryMore) {
            var ok = await loadMoreHistory();
            if (!ok) break;
            updatePortProfit();
            renderCalendar();
            renderHistoryForDate(portSelectedDate);
            var cntEl = document.getElementById('port-settled-count');
            if (cntEl) cntEl.textContent = portHistoryAll.length + (portHistoryMore ? '+' : '');
            if (statusEl) statusEl.textContent = portHistoryMore ? 'Loading ' + portHistoryAll.length + ' bets…' : '';
            await new Promise(function(r){ setTimeout(r, 150); });
        }
        if (statusEl) statusEl.textContent = '';
        var cntEl = document.getElementById('port-settled-count');
        if (cntEl) cntEl.textContent = portHistoryAll.length;
        updatePortProfit();
        updatePerfCards();
        updatePortFilterOptions();
        renderCalendar();
        renderHistoryForDate(portSelectedDate);
        // Save everything to cache so next visit is instant
        saveHistoryCache();
    }

    function renderHistoryForDate(dateKey) {
        portSelectedDate = dateKey;
        var FREE_HISTORY_CUTOFF = Date.now() - 7 * 24 * 60 * 60 * 1000;
        var filtered = portHistoryAll.filter(function(p) {
            if (!p.transactedAt) return false;
            if (!isPro() && new Date(p.transactedAt).getTime() < FREE_HISTORY_CUTOFF) return false;
            if (!portShowAllTime && localDateKey(p.transactedAt) !== dateKey) return false;
            if (portFilterSport  && getHistSport(p)  !== portFilterSport)  return false;
            if (portFilterMarket && getHistMarket(p) !== portFilterMarket) return false;
            if (portFilterResult && getHistResult(p) !== portFilterResult) return false;
            if (portSearchQuery) {
                var haystack = (((p.marketDisplay && p.marketDisplay.display) || '') + ' ' + (p.outcomeLabel || '') + ' ' + (p.headerLabel || '')).toLowerCase();
                if (haystack.indexOf(portSearchQuery) === -1) return false;
            }
            return true;
        });
        // Sort
        filtered = filtered.slice().sort(function(a, b) {
            if (portSortBy === 'chrono-asc')  return new Date(a.transactedAt) - new Date(b.transactedAt);
            if (portSortBy === 'profit-desc') return getHistProfit(b) - getHistProfit(a);
            if (portSortBy === 'profit-asc')  return getHistProfit(a) - getHistProfit(b);
            return new Date(b.transactedAt) - new Date(a.transactedAt); // chrono-desc
        });
        var histTbody = document.getElementById('port-history-tbody');
        if (!histTbody) return;

        // Filter totals panel — show whenever any filter is active
        var hasFilter = !!(portFilterSport || portFilterMarket || portFilterResult || portSearchQuery);
        var totalsEl = document.getElementById('port-filter-totals');
        if (totalsEl) {
            if (hasFilter && filtered.length) {
                var ftWins = 0, ftLosses = 0, ftCash = 0, ftProfit = 0, ftCost = 0;
                var ftUnit = parseFloat(localStorage.getItem('raxedge_unit_size') || '300') || 300;
                filtered.forEach(function(p) {
                    var res = getHistResult(p);
                    var details = Array.isArray(p.details) ? p.details : [];
                    var costNum = parseRaxDisplay((details.find(function(d){ return d.label==='Cost'; }) || {}).display);
                    var paidNum = parseRaxDisplay((details.find(function(d){ return d.label==='Paid'; }) || {}).display);
                    if (res === 'win')     ftWins++;
                    else if (res === 'loss') ftLosses++;
                    else if (res === 'cashout') ftCash++;
                    ftProfit += paidNum - costNum;
                    ftCost   += costNum;
                });
                var ftTotal   = ftWins + ftLosses + ftCash;
                var ftDecided = ftWins + ftLosses + ftCash;
                var ftWinRate = ftDecided > 0 ? (ftWins / ftDecided * 100) : null;
                var ftRoi     = ftCost > 0 ? (ftProfit / ftCost * 100) : null;
                var ftUnits   = ftProfit / ftUnit;
                var posColor  = 'var(--green)', negColor = 'var(--red)';
                var recordStr = ftWins + '-' + ftLosses + (ftCash ? '-' + ftCash + 'co' : '') + ' (' + ftTotal + ')';
                document.getElementById('pft-record').textContent  = recordStr;
                var wrEl = document.getElementById('pft-winrate');
                wrEl.textContent  = ftWinRate !== null ? ftWinRate.toFixed(1) + '%' : '—';
                wrEl.style.color  = ftWinRate !== null ? (ftWinRate >= 50 ? posColor : negColor) : 'var(--fg)';
                var prEl = document.getElementById('pft-profit');
                prEl.innerHTML = RAX_ICON + (ftProfit >= 0 ? '+' : '') + fmtRax(ftProfit);
                prEl.style.color  = ftProfit >= 0 ? posColor : negColor;
                var unEl = document.getElementById('pft-units');
                unEl.textContent  = (ftUnits >= 0 ? '+' : '') + ftUnits.toFixed(2) + 'u';
                unEl.style.color  = ftUnits >= 0 ? posColor : negColor;
                var roiEl = document.getElementById('pft-roi');
                roiEl.textContent = ftRoi !== null ? (ftRoi >= 0 ? '+' : '') + ftRoi.toFixed(1) + '%' : '—';
                roiEl.style.color = ftRoi !== null ? (ftRoi >= 0 ? posColor : negColor) : 'var(--fg)';
                totalsEl.style.display = '';
            } else {
                totalsEl.style.display = 'none';
            }
        }

        if (!filtered.length) {
            var msg = portHistoryMore ? 'Still loading…' : (portFilterSport || portFilterMarket || portFilterResult ? 'No bets match the filters' : 'No settled bets on this date');
            histTbody.innerHTML = '<tr><td colspan="8" style="color:var(--muted);padding:20px 12px">' + msg + '</td></tr>';
        } else {
            histTbody.innerHTML = filtered.map(function(p) { return histRowHtml(p); }).join('');
        }
        // Free users: show upgrade banner below history table
        if (!isPro()) {
            histTbody.innerHTML += '<tr><td colspan="8" style="padding:12px;text-align:center;border-top:1px solid var(--border)">'
                + '<span style="color:var(--muted);font-size:12px">Showing last 7 days only. </span>'
                + '<button onclick="showUpgradeModal(\'Upgrade to Pro to unlock your complete betting history.\')" style="background:none;border:none;color:var(--accent);font-size:12px;font-weight:600;cursor:pointer;padding:0;text-decoration:underline">Upgrade to Pro for full history →</button>'
                + '</td></tr>';
        }
    }

    function updatePortProfit() {
        // Recalculate total realised profit from all loaded history items
        var total = 0;
        portHistoryAll.forEach(function(p) {
            var details = Array.isArray(p.details) ? p.details : [];
            var costDet = details.find(function(d){ return d.label === 'Cost'; }) || {};
            var paidDet = details.find(function(d){ return d.label === 'Paid'; }) || {};
            var cost = parseRaxDisplay(costDet.display);
            var paid = parseRaxDisplay(paidDet.display);
            total += paid - cost;
        });
        var el = document.getElementById('port-settled-profit');
        if (el) {
            var spUnit    = parseFloat(localStorage.getItem('raxedge_unit_size') || '300') || 300;
            var spUnitStr = (total / spUnit);
            el.innerHTML = RAX_ICON + (total >= 0 ? '+' : '') + fmtRax(total) + ' (' + (spUnitStr >= 0 ? '+' : '') + spUnitStr.toFixed(2) + 'u)';
            el.style.color = total >= 0 ? 'var(--green)' : 'var(--red)';
        }
        // Update settled count
        var cnt = document.getElementById('port-settled-count');
        if (cnt) cnt.textContent = portHistoryAll.length + (portHistoryMore ? '+' : '');
    }

    function fmtPortDate(iso) {
        if (!iso) return '—';
        var d = new Date(iso);
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var h = d.getHours(), m = d.getMinutes();
        var ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        var mm = m < 10 ? '0' + m : m;
        return months[d.getMonth()] + ' ' + d.getDate() + ', ' + h + ':' + mm + ' ' + ampm;
    }

    function histRowHtml(p) {
        var matchup  = (p.marketDisplay && p.marketDisplay.display) || '—';
        var market   = p.headerLabel || '—';
        var side     = p.outcomeLabel || '—';
        var details  = Array.isArray(p.details) ? p.details : [];
        var costDet  = details.find(function(d){ return d.label === 'Cost'; }) || {};
        var paidDet  = details.find(function(d){ return d.label === 'Paid'; }) || {};
        var avgDet   = details.find(function(d){ return d.label === 'Avg' || d.label === 'Price' || d.label === 'Entry'; }) || {};
        var costDisp = costDet.display || '—';
        var paidDisp = paidDet.display || '—';
        var paidNum  = parseRaxDisplay(paidDet.display);
        var costNum  = parseRaxDisplay(costDet.display);
        // Derive entry price: for wins cost/paid*100 gives the buy % (e.g. 200/276 = 72%)
        // For losses we can't compute from paid=0, so fall back to API field or '—'
        var avgDisp  = avgDet.display || (paidNum > 0 ? Math.round(costNum / paidNum * 100) + '%' : '—');
        var isWin      = paidDet.color === 'green' && paidNum > 0;
        var isLoss     = paidDet.display === '0' || (!isWin && paidDet.color === 'default');
        var profitNum  = paidNum - costNum;
        // Early cashout: API marks green but paid back less than cost
        var isCashout  = isWin && profitNum < 0;
        var resCls     = (isWin && !isCashout) ? 'port-win' : (isLoss || isCashout) ? 'port-loss' : '';
        var unitSize   = parseFloat(localStorage.getItem('raxedge_unit_size') || '300') || 300;
        var profitRax  = '';
        var profitUnit = '';
        if (isWin || isLoss) {
            var unitStr = (profitNum / unitSize);
            profitRax  = '<span style="font-size:11px;font-weight:600;white-space:nowrap">' + RAX_ICON + (profitNum >= 0 ? '+' : '') + fmtRax(profitNum) + '</span>';
            profitUnit = '<span style="font-size:10px;color:var(--muted);font-family:var(--mono);display:block;white-space:nowrap">' + (unitStr >= 0 ? '+' : '') + unitStr.toFixed(2) + 'u</span>';
        }
        var profit     = profitRax ? ' ' + profitRax + profitUnit : '';
        var resLbl     = isCashout ? 'Cashout' : isWin ? 'Win' : isLoss ? 'Loss' : '—';
        var trCls      = isCashout ? 'port-card-loss' : isWin ? 'port-card-win' : isLoss ? 'port-card-loss' : '';
        var dateStr  = fmtPortDate(p.transactedAt);
        var histGameUrl = getPortfolioGameUrl(p);
        var histGameLink = histGameUrl ? ' <a href="' + histGameUrl + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--accent);font-size:11px;text-decoration:none;opacity:0.85" title="View on Real Sports">&#8599;</a>' : '';
        return '<tr class="' + trCls + '">'
            + '<td data-label="Date" style="white-space:nowrap;font-size:11px;color:var(--muted);font-family:var(--mono)">' + escHtml(dateStr) + '</td>'
            + '<td data-label="Matchup">' + escHtml(matchup) + histGameLink + '</td>'
            + '<td data-label="Market"><span class="mkt-badge" style="font-size:10px">' + escHtml(market) + '</span></td>'
            + '<td data-label="Side">' + escHtml(side) + '</td>'
            + '<td data-label="Avg" class="r" style="font-family:var(--mono);color:var(--muted)">' + escHtml(avgDisp) + '</td>'
            + '<td data-label="Cost" class="r" style="font-family:var(--mono);color:var(--muted)">' + escHtml(costDisp) + '</td>'
            + '<td data-label="Paid" class="r ' + ((isWin && !isCashout) ? 'port-win' : 'port-loss') + '" style="font-family:var(--mono)">' + escHtml(paidDisp) + '</td>'
            + '<td data-label="Result" class="' + resCls + '" style="font-weight:700;font-size:12px;white-space:normal">' + resLbl + profit + '</td>'
            + '</tr>';
    }

    function getField(obj, keys) {
        for (var i = 0; i < keys.length; i++) {
            if (obj[keys[i]] != null) return obj[keys[i]];
        }
        return null;
    }

    function fmtRax(n) {
        n = Number(n);
        if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
        return n.toFixed(2);
    }

    function fmtNum(n) {
        n = Number(n);
        if (Number.isInteger(n)) return n.toString();
        return n.toFixed(2);
    }

    function escHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    async function loadReferralStats() {
        try {
            var res = await fetch('/api/referral/stats', { credentials: 'same-origin' });
            var data = await res.json();
            if (!data.ok) return;
            document.getElementById('ref-count').textContent = data.paidReferrals || 0;
            document.getElementById('ref-months').textContent = data.monthsEarned || 0;
            var expiry = data.proExpiresAt;
            if (expiry) {
                var d = new Date(expiry * 1000);
                document.getElementById('ref-expiry').textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } else {
                document.getElementById('ref-expiry').textContent = data.plan === 'pro' ? 'Active' : '—';
            }
            document.getElementById('ref-code-display').textContent = data.referralCode || '—';
        } catch(e) {}
        if (isPro()) loadGroupCode();
    }

    async function loadGroupCode() {
        try {
            var res = await fetch('/api/group/join', { credentials: 'same-origin' });
            if (!res.ok) return;
            var data = await res.json();
            if (!data.ok) return;
            var ddItem = document.getElementById('dd-group-item');
            if (ddItem) ddItem.style.display = '';
            if (data.joined && data.rs_username) {
                window._groupJoined = true;
                window._groupUsername = data.rs_username;
                window._groupLink = data.link || 'https://www.realapp.com/ZdWcrFgFN6p';
                window._groupCode = data.code || null;
            }
        } catch(e) {}
    }

    function showGroupJoinedView() {
        document.getElementById('group-join-form').style.display = 'none';
        document.getElementById('group-joined-view').style.display = '';
        var lbl = document.getElementById('group-member-label');
        if (lbl) lbl.textContent = 'Joined as ' + (window._groupUsername || '');
        var link = document.getElementById('group-open-link');
        if (link && window._groupLink) link.href = window._groupLink;
        var codeWrap = document.getElementById('group-code-wrap');
        var codeDisplay = document.getElementById('group-code-display');
        if (codeWrap && codeDisplay && window._groupCode) {
            codeDisplay.textContent = window._groupCode;
            codeWrap.style.display = '';
        }
    }

    function openGroupCodeModal() {
        var m = document.getElementById('group-code-modal');
        closeMenu();
        if (window._groupJoined && window._groupUsername) {
            showGroupJoinedView();
        } else {
            document.getElementById('group-join-form').style.display = '';
            document.getElementById('group-joined-view').style.display = 'none';
            var inp = document.getElementById('group-rs-username');
            if (inp) { inp.value = ''; inp.disabled = false; }
            var btn = document.getElementById('group-join-btn');
            if (btn) { btn.textContent = 'Join Predicts Group'; btn.disabled = false; }
            document.getElementById('group-join-error').style.display = 'none';
        }
        m.style.display = 'flex';
    }

    function closeGroupCodeModal() {
        document.getElementById('group-code-modal').style.display = 'none';
    }

    async function submitGroupJoin() {
        var inp = document.getElementById('group-rs-username');
        var btn = document.getElementById('group-join-btn');
        var err = document.getElementById('group-join-error');
        var username = (inp.value || '').trim();
        if (!username) { err.textContent = 'Enter your RealSports username'; err.style.display = ''; return; }
        err.style.display = 'none';
        btn.textContent = 'Verifying...';
        btn.disabled = true;
        inp.disabled = true;
        try {
            var res = await fetch('/api/group/join', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rs_username: username })
            });
            var data = await res.json();
            if (!data.ok) {
                err.textContent = data.error || 'Failed to join — try again';
                err.style.display = '';
                btn.textContent = 'Join Predicts Group';
                btn.disabled = false;
                inp.disabled = false;
                return;
            }
            window._groupJoined = true;
            window._groupUsername = data.rs_username || username;
            window._groupLink = data.link || 'https://www.realapp.com/ZdWcrFgFN6p';
            window._groupCode = data.code || null;
            showGroupJoinedView();
        } catch(e) {
            err.textContent = 'Network error — try again';
            err.style.display = '';
            btn.textContent = 'Join Predicts Group';
            btn.disabled = false;
            inp.disabled = false;
        }
    }

    function copyRefCode() {
        var code = document.getElementById('ref-code-display').textContent;
        navigator.clipboard.writeText(code).then(function() {
            var btn = document.getElementById('ref-copy-btn');
            btn.textContent = 'Copied!';
            setTimeout(function() { btn.textContent = 'Copy Code'; }, 2000);
        }).catch(function() {
            var el = document.createElement('textarea');
            el.value = code;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
        });
    }

    function copyGroupLink() {
        var link = window._groupLink || 'https://www.realapp.com/ZdWcrFgFN6p';
        navigator.clipboard.writeText(link).then(function() {
            var btn = document.getElementById('rs-group-copy-btn');
            btn.textContent = 'Copied!';
            setTimeout(function() { btn.textContent = 'Copy Group Link'; }, 2000);
        }).catch(function() {
            var el = document.createElement('textarea');
            el.value = link;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
        });
    }

    function copyGroupCode() {
        var code = window._groupCode || '';
        if (!code) return;
        navigator.clipboard.writeText(code).then(function() {
            var btn = document.getElementById('group-code-copy-btn');
            btn.textContent = 'Copied!';
            setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
        }).catch(function() {
            var el = document.createElement('textarea');
            el.value = code;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
        });
    }

    async function loadAdminStats() {
        try {
            var res = await fetch('/api/admin/stats', { credentials: 'same-origin' });
            var data = await res.json();
            if (!data.ok) return;
            document.getElementById('adm-total').textContent = data.total;
            document.getElementById('adm-week').textContent = data.newWeek;
            document.getElementById('adm-sessions').textContent = data.sessions;
            var pro = (data.plans || []).find(function(p) { return p.plan === 'pro'; });
            document.getElementById('adm-pro').textContent = pro ? pro.c : 0;
        } catch (e) {}
    }

    async function loadAdminUsers(q, offset, append) {
        if (offset === undefined) offset = 0;
        var plan  = document.getElementById('admin-plan-filter')  ? document.getElementById('admin-plan-filter').value  : '';
        var sort  = document.getElementById('admin-sort')          ? document.getElementById('admin-sort').value          : '';
        var group = document.getElementById('admin-group-filter') ? document.getElementById('admin-group-filter').value : '';
        var params = ['limit=50', 'offset=' + offset];
        if (q)     params.push('q='     + encodeURIComponent(q));
        if (plan)  params.push('plan='  + encodeURIComponent(plan));
        if (sort)  params.push('sort='  + encodeURIComponent(sort));
        if (group !== '') params.push('group=' + encodeURIComponent(group));
        var url = '/api/admin/users?' + params.join('&');
        try {
            var res = await fetch(url, { credentials: 'same-origin' });
            var data = await res.json();
            if (!data.ok) return;
            adminOffset = offset + (data.users || []).length;
            adminHasMore = data.hasMore || false;
            renderAdminUsers(data.users || [], append, data.total);
        } catch (e) {}
    }

    function adminSearch() {
        clearTimeout(adminSearchTimer);
        adminSearchTimer = setTimeout(function() {
            loadAdminUsers(document.getElementById('admin-search').value.trim(), 0, false);
        }, 300);
    }

    function renderAdminUsers(users, append, total) {
        var tb = document.getElementById('admin-tbody');
        var loadMoreWrap = document.getElementById('admin-load-more-wrap');
        if (!append && !users.length) {
            tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:40px">No users found</td></tr>';
            if (loadMoreWrap) loadMoreWrap.style.display = 'none';
            return;
        }
        var rows = users.map(function(u) {
            var date = new Date(u.created_at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            var proExpires = (u.plan === 'pro' && u.pro_expires_at) ? new Date(u.pro_expires_at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
            var planBadge = u.plan === 'pro' ? '<span class="badge-pro">PRO</span>' : '<span class="badge-free">FREE</span>';
            var adminBadge = u.is_admin ? ' <span class="badge-admin">ADMIN</span>' : '';
            var bannedBadge = u.banned ? ' <span class="badge-banned">BANNED</span>' : '';
            var banBtn = u.banned
                ? '<button class="admin-btn unban-btn" onclick="adminSetBanned(' + u.id + ',false)">Unban</button>'
                : '<button class="admin-btn ban-btn" onclick="adminSetBanned(' + u.id + ',true)">Ban</button>';
            var actions = u.is_admin ? '<span style="color:var(--muted2);font-size:12px">--</span>' :
                '<div style="display:flex;gap:6px;flex-wrap:wrap">'
                + '<button class="admin-btn logout-btn" onclick="adminForceLogout(' + u.id + ')">Logout</button>'
                + banBtn
                + '<button class="admin-btn del-btn" data-uid="' + u.id + '" data-email="' + escHtml(u.email) + '" onclick="adminDeleteUser(+this.dataset.uid, this.dataset.email)">Delete</button>'
                + '</div>';
            var groupChecked = u.group_access ? ' checked' : '';
            var groupRsVal   = escHtml(u.rs_group_username || '');
            var groupCell    = '<div style="display:flex;flex-direction:column;gap:4px">'
                + '<label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">'
                + '<input type="checkbox" data-uid="' + u.id + '"' + groupChecked + ' onchange="adminToggleGroup(this)"> Access</label>'
                + '<input type="text" placeholder="RS username" value="' + groupRsVal + '" data-uid="' + u.id + '" style="font-size:11px;font-family:var(--mono);background:var(--bg3);border:1px solid var(--border2);color:var(--fg);padding:3px 6px;border-radius:4px;width:100px" onblur="adminSaveRsUsername(this)" onkeydown="if(event.key===\'Enter\')this.blur()">'
                + '</div>';
            var rsProfileLink = u.rs_group_username
                ? '<div class="rs-profile-link" style="margin-top:3px"><a href="https://realsports.io/u/' + escHtml(u.rs_group_username) + '" target="_blank" rel="noopener" style="font-size:10px;color:var(--accent);font-family:var(--mono)">RS&nbsp;↗</a></div>'
                : '';
            var rsIdCell = u.rs_user_id
                ? '<div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:2px">RS&nbsp;ID:&nbsp;' + escHtml(String(u.rs_user_id)) + (u.rs_username ? '&nbsp;(' + escHtml(u.rs_username) + ')' : '') + '</div>'
                : '';
            return '<tr>'
                + '<td><span style="font-family:var(--mono);font-size:12px">' + escHtml(u.email) + '</span>' + adminBadge + bannedBadge + rsProfileLink + rsIdCell + '</td>'
                + '<td>'
                + '<select class="plan-sel" data-uid="' + u.id + '" onchange="adminChangePlan(this)"><option value="free"' + (u.plan === 'free' ? ' selected' : '') + '>Free</option><option value="pro"' + (u.plan === 'pro' ? ' selected' : '') + '>Pro</option></select>'
                + '<div style="display:flex;align-items:center;gap:4px;margin-top:5px">'
                + '<input type="number" min="1" max="24" value="3" class="admin-grant-inp" style="width:36px;background:var(--bg3);border:1px solid var(--border2);color:var(--fg);font-family:var(--mono);font-size:11px;padding:2px 4px;border-radius:4px;text-align:center">'
                + '<button class="admin-btn" style="font-size:10px;padding:2px 8px" onclick="adminGrantMonths(' + u.id + ',this)">+Mo</button>'
                + '</div>'
                + '</td>'
                + '<td>' + groupCell + '</td>'
                + '<td style="font-family:var(--mono);color:var(--muted)">' + u.sessions + '</td>'
                + '<td style="font-family:var(--mono);font-size:12px;color:var(--muted)">' + date + '</td>'
                + '<td style="font-family:var(--mono);font-size:12px;color:var(--muted)">' + proExpires + '</td>'
                + '<td>' + actions + '</td>'
                + '</tr>';
        }).join('');
        if (append) {
            tb.innerHTML += rows;
        } else {
            tb.innerHTML = rows;
        }
        if (loadMoreWrap) {
            if (adminHasMore) {
                loadMoreWrap.style.display = 'flex';
                var lbl = document.getElementById('admin-load-more-lbl');
                if (lbl && total) lbl.textContent = 'Showing ' + adminOffset + ' of ' + total;
            } else {
                loadMoreWrap.style.display = 'none';
            }
        }
    }

    function adminLoadMore() {
        var q = document.getElementById('admin-search').value.trim();
        loadAdminUsers(q, adminOffset, true);
    }

    async function adminChangePlan(sel) {
        var id = sel.getAttribute('data-uid');
        var plan = sel.value;
        await fetch('/api/admin/users', { method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: parseInt(id), plan }) });
    }

    function adminGrantMonths(id, btn) {
        var row = btn.closest('tr');
        var inp = row ? row.querySelector('.admin-grant-inp') : null;
        var months = parseInt(inp ? inp.value : 3, 10);
        if (!months || months < 1) return;
        showConfirm('Grant ' + months + ' month' + (months !== 1 ? 's' : '') + ' Pro to user #' + id + '?', async function() {
            var res = await fetch('/api/admin/users', {
                method: 'PATCH', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: id, grant_months: months })
            });
            var data = await res.json();
            if (data.ok) {
                var via = data.via === 'credits' ? ' (via invoice credits)' : ' (expiry extended)';
                showToast('Granted ' + months + ' month' + (months !== 1 ? 's' : '') + ' Pro' + via);
                loadAdminUsers(document.getElementById('admin-search').value.trim(), 0, false);
            } else {
                showToast(data.error || 'Error granting Pro');
            }
        });
    }

    async function adminForceLogout(id) {
        await fetch('/api/admin/users?id=' + id, { method: 'POST', credentials: 'same-origin' });
        loadAdminUsers(document.getElementById('admin-search').value.trim(), 0, false);
        loadAdminStats();
    }

    async function adminSetBanned(id, banned) {
        await fetch('/api/admin/users', { method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, banned }) });
        loadAdminUsers(document.getElementById('admin-search').value.trim(), 0, false);
    }

    async function adminToggleGroup(cb) {
        var id = parseInt(cb.getAttribute('data-uid'));
        var res = await fetch('/api/admin/users', { method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, group_access: cb.checked }) });
        var data = await res.json();
        if (!data.ok) { showToast(data.error || 'Error updating group access'); cb.checked = !cb.checked; }
    }

    async function adminSaveRsUsername(input) {
        var id  = parseInt(input.getAttribute('data-uid'));
        var val = input.value.trim();
        var cell = input.closest('td');
        var cb = cell ? cell.querySelector('input[type="checkbox"]') : null;
        var newAccess = val ? 1 : 0;
        input.disabled = true;
        var res = await fetch('/api/admin/users', { method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, rs_group_username: val, group_access: newAccess }) });
        var data = await res.json();
        input.disabled = false;
        if (!data.ok) { showToast(data.error || 'Error saving RS username'); return; }
        if (cb) cb.checked = !!val;
        if (cell) {
            var existing = cell.querySelector('.rs-profile-link');
            if (existing) existing.remove();
            if (val) {
                var link = document.createElement('div');
                link.className = 'rs-profile-link';
                link.style.cssText = 'margin-top:3px';
                link.innerHTML = '<a href="https://realsports.io/u/' + escHtml(val) + '" target="_blank" rel="noopener" style="font-size:10px;color:var(--accent);font-family:var(--mono)">RS&nbsp;↗</a>';
                input.parentNode.insertBefore(link, input);
            }
            showToast('Saved', 'success');
        }
    }

    async function adminDeleteUser(id, email) {
        showConfirm('Permanently delete ' + email + '? This cannot be undone.', async function() { await _doAdminDeleteUser(id); });
        return;
    }
    async function _doAdminDeleteUser(id) {
        await fetch('/api/admin/users?id=' + id, { method: 'DELETE', credentials: 'same-origin' });
        loadAdminUsers(document.getElementById('admin-search').value.trim(), 0, false);
        loadAdminStats();
    }

    async function adminSyncStripe() {
        var btn = document.getElementById('sync-stripe-btn');
        btn.textContent = 'Syncing...';
        btn.disabled = true;
        try {
            var res = await fetch('/api/admin/sync-stripe', { method: 'POST', credentials: 'same-origin' });
            var data = await res.json();
            if (data.ok) {
                btn.textContent = 'Synced (' + (data.upgraded || 0) + ' up, ' + (data.downgraded || 0) + ' down)';
                var lines = [];
                if (data.detail.upgraded.length) lines.push('UPGRADED:\n' + data.detail.upgraded.map(function(u) { return '  ' + u.email + ' (' + u.from + ' → pro, ' + u.status + ')'; }).join('\n'));
                if (data.detail.downgraded.length) lines.push('DOWNGRADED:\n' + data.detail.downgraded.map(function(u) { return '  ' + u.email + ' → free (' + u.status + ')'; }).join('\n'));
                if (data.detail.errors.length) lines.push('ERRORS:\n' + data.detail.errors.map(function(e) { return '  ' + e; }).join('\n'));
                if (lines.length) showToast(lines.join('\n\n'));
            } else {
                btn.textContent = 'Error';
            }
        } catch(e) {
            btn.textContent = 'Error';
        }
        loadAdminUsers(document.getElementById('admin-search').value.trim(), 0, false);
        loadAdminStats();
        setTimeout(function() { btn.textContent = 'Sync Stripe'; btn.disabled = false; }, 4000);
    }

    async function adminGroupSync() {
        var btn = document.getElementById('group-sync-btn');
        btn.textContent = 'Syncing...';
        btn.disabled = true;
        try {
            var res = await fetch('/api/admin/group-sync', { credentials: 'same-origin' });
            var data = await res.json();
            if (!data.ok) { showToast(data.error || 'Sync failed'); btn.textContent = 'Group Sync'; btn.disabled = false; return; }

            var wrap = document.getElementById('group-sync-results');
            var stats = document.getElementById('group-sync-stats');
            stats.textContent = data.rsTotal + ' in RS group · ' + data.adminGroupTotal + ' with access in admin · ' + data.matched.length + ' matched';
            wrap.style.display = '';

            var rsOnly = document.getElementById('group-sync-rs-only');
            var rsOnlyList = document.getElementById('group-sync-rs-only-list');
            if (data.inRsOnly.length) {
                rsOnlyList.innerHTML = data.inRsOnly.map(function(m) {
                    return '<div>' + escHtml(m.rsUsername) + ' <span style="color:var(--muted2);font-size:11px">(' + escHtml(m.rsId) + ')</span></div>';
                }).join('');
                rsOnly.style.display = '';
            } else {
                rsOnly.style.display = 'none';
            }

            var adminOnly = document.getElementById('group-sync-admin-only');
            var adminOnlyList = document.getElementById('group-sync-admin-only-list');
            if (data.inAdminOnly.length) {
                adminOnlyList.innerHTML = data.inAdminOnly.map(function(u) {
                    return '<div>' + escHtml(u.email) + (u.rs_group_username ? ' → RS: ' + escHtml(u.rs_group_username) : ' <span style="color:var(--red)">(no RS username set)</span>') + '</div>';
                }).join('');
                adminOnly.style.display = '';
            } else {
                adminOnly.style.display = 'none';
            }

            document.getElementById('group-sync-ok').style.display = (!data.inRsOnly.length && !data.inAdminOnly.length) ? '' : 'none';
        } catch(e) {
            showToast('Network error');
        }
        btn.textContent = 'Group Sync';
        btn.disabled = false;
    }

    function onMktChange() {
        var sel = document.getElementById('mkt-filter');
        if (!isPro() && sel.value !== 'ML') {
            sel.value = 'ML';
            showUpgradeModal('Spread and Total markets are available on the Pro plan. Upgrade to access all betting markets.');
            return;
        }
        if (currentSport === 'basketball_wnba' && sel.value !== 'ML') {
            sel.value = 'ML';
            return;
        }
        loadOdds();
    }

    function isPro() {
        // Free promo — set date to future to activate, past to disable
        var FREE_PROMO_END = new Date('2026-04-06T04:59:00Z');
        return currentUser && (currentUser.plan === 'pro' || currentUser.is_admin || new Date() < FREE_PROMO_END);
    }

    function toggleTheme() {
        var isLight = document.documentElement.classList.toggle('light');
        localStorage.setItem('raxedge_theme', isLight ? 'light' : 'dark');
        syncMenuDropdown();
    }

    function toggleStickyHeader() {
        var el = document.querySelector('.subheader-sticky');
        var isOff = el.classList.toggle('sticky-off');
        localStorage.setItem('raxedge_sticky_off', isOff ? '1' : '0');
        syncMenuDropdown();
    }

    function initStickyHeader() {
        var isOff = localStorage.getItem('raxedge_sticky_off') === '1';
        var el = document.querySelector('.subheader-sticky');
        if (isOff && el) el.classList.add('sticky-off');
    }

    function initTheme() {
        var saved = localStorage.getItem('raxedge_theme');
        document.documentElement.classList.toggle('light', saved === 'light');
    }

    function syncMenuDropdown() {
        var isLight = document.documentElement.classList.contains('light');
        var isOff   = !!(document.querySelector('.subheader-sticky') && document.querySelector('.subheader-sticky').classList.contains('sticky-off'));
        var icon  = document.getElementById('dd-theme-icon');
        var label = document.getElementById('dd-theme-label');
        var si    = document.getElementById('dd-sticky-item');
        if (icon)  icon.textContent  = isLight ? '☀️' : '🌙';
        if (label) label.textContent = isLight ? 'Light mode' : 'Dark mode';
        if (si)    si.classList.toggle('dd-active', !isOff);
    }

    // ── Hamburger menu ──
    function toggleMenu() {
        var dd = document.getElementById('menu-dropdown');
        var btn = document.getElementById('menu-btn');
        if (!dd || !btn) return;
        if (dd.classList.contains('open')) {
            dd.classList.remove('open');
        } else {
            syncMenuDropdown();
            var r = btn.getBoundingClientRect();
            dd.style.top  = (r.bottom + 6) + 'px';
            dd.style.right = (window.innerWidth - r.right) + 'px';
            dd.classList.add('open');
        }
    }

    function closeMenu() {
        var dd = document.getElementById('menu-dropdown');
        if (dd) dd.classList.remove('open');
    }

    document.addEventListener('click', function(e) {
        var wrap = document.getElementById('menu-wrap');
        if (wrap && !wrap.contains(e.target)) closeMenu();
    });

    // ── Sport order ──
    function getSportOrder() {
        try {
            var saved = JSON.parse(localStorage.getItem('rax_sport_order') || 'null');
            if (Array.isArray(saved)) {
                var result = saved.filter(function(k) { return SPORTS.some(function(s) { return s.key === k; }); });
                SPORTS.forEach(function(s) { if (result.indexOf(s.key) === -1) result.push(s.key); });
                return result;
            }
        } catch(e) {}
        return SPORTS.map(function(s) { return s.key; });
    }

    function orderedSports() {
        return getSportOrder().map(function(k) { return SPORTS.find(function(s) { return s.key === k; }); }).filter(Boolean);
    }

    var _pendingSportOrder = null;
    var _sortDragState = null;

    function startSortDrag(e, startIdx) {
        if (!_pendingSportOrder) return;
        var list = document.getElementById('sort-list');
        var items = Array.from(list.querySelectorAll('.sort-drag-item'));
        var item = items[startIdx];
        if (!item) return;
        var rect = item.getBoundingClientRect();
        var itemH = rect.height + 6; // height + margin-bottom
        var ghost = item.cloneNode(true);
        ghost.style.cssText = 'position:fixed;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;z-index:99999;pointer-events:none;border:1px solid var(--accent);border-radius:6px;box-shadow:0 12px 32px rgba(0,0,0,.5);opacity:.96;transform:scale(1.03);background:var(--bg3);display:flex;align-items:center;gap:8px;padding:9px 10px;font-size:13px;font-family:var(--sans);font-weight:600;color:var(--fg)';
        ghost.innerHTML = item.innerHTML;
        document.body.appendChild(ghost);
        item.style.opacity = '0';
        document.body.style.overflow = 'hidden';
        _sortDragState = { startIdx: startIdx, currentIdx: startIdx, startY: e.clientY, ghostTop: rect.top, itemH: itemH, items: items, ghost: ghost, dragItem: item };
    }

    function onSortPointerMove(e) {
        var s = _sortDragState;
        if (!s) return;
        e.preventDefault();
        var dy = e.clientY - s.startY;
        s.ghost.style.top = (s.ghostTop + dy) + 'px';
        var newIdx = Math.round(s.startIdx + dy / s.itemH);
        newIdx = Math.max(0, Math.min(s.items.length - 1, newIdx));
        if (newIdx === s.currentIdx) return;
        s.currentIdx = newIdx;
        s.items.forEach(function(el, i) {
            if (i === s.startIdx) return;
            var shift = 0;
            if (s.startIdx < newIdx && i > s.startIdx && i <= newIdx) shift = -s.itemH;
            if (s.startIdx > newIdx && i >= newIdx && i < s.startIdx) shift = s.itemH;
            el.style.transition = 'transform 0.15s ease';
            el.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
        });
    }

    function onSortPointerUp() {
        document.removeEventListener('pointermove', onSortPointerMove);
        document.body.style.overflow = '';
        var s = _sortDragState;
        _sortDragState = null;
        if (!s) return;
        if (s.currentIdx !== s.startIdx) {
            var arr = _pendingSportOrder.slice();
            var moved = arr.splice(s.startIdx, 1)[0];
            arr.splice(s.currentIdx, 0, moved);
            _pendingSportOrder = arr;
        }
        s.ghost.remove();
        s.dragItem.style.opacity = '';
        s.items.forEach(function(el) { el.style.transition = 'none'; el.style.transform = ''; });
        renderSortList();
    }

    function openSportOrderModal() {
        closeMenu();
        _pendingSportOrder = getSportOrder();
        renderSortList();
        var bg = document.getElementById('sort-modal-bg');
        if (bg) { bg.style.display = 'flex'; }
    }

    function closeSportOrderModal() {
        var bg = document.getElementById('sort-modal-bg');
        if (bg) bg.style.display = 'none';
        _pendingSportOrder = null;
    }

    function saveSportOrder() {
        var order = _pendingSportOrder ? _pendingSportOrder.slice() : getSportOrder();
        localStorage.setItem('rax_sport_order', JSON.stringify(order));
        closeSportOrderModal();
        // Exit Best EV if active
        var evBtn = document.getElementById('ev-tab-btn');
        if (evBtn && evBtn.classList.contains('active')) {
            evBtn.classList.remove('active');
            evBtn.textContent = '⚡ Best EV';
            hideEvTab();
        }
        // Pick first unlocked sport in the new order
        var pro = isPro();
        var firstKey = order[0];
        for (var i = 0; i < order.length; i++) {
            if (pro || FREE_SPORTS.indexOf(order[i]) !== -1) { firstKey = order[i]; break; }
        }
        currentSport = firstKey;
        buildTabs();
        if (firstKey === 'soccer_fc') {
            currentFcLeague = 'ALL';
            buildFcLeagueNav();
            document.getElementById('fc-league-nav').style.display = 'flex';
            document.getElementById('wc-sub-nav').style.display = 'none';
        } else if (firstKey === 'soccer_wc') {
            document.getElementById('fc-league-nav').style.display = 'none';
            wcSubTab = 'games';
            buildWcSubNav();
            document.getElementById('wc-sub-nav').style.display = 'flex';
        } else {
            document.getElementById('fc-league-nav').style.display = 'none';
            document.getElementById('wc-sub-nav').style.display = 'none';
        }
        loadOdds();
        startScoresPoller(firstKey);
    }

    function renderSortList() {
        var pro = isPro();
        var list = document.getElementById('sort-list');
        if (!list || !_pendingSportOrder) return;
        var n = _pendingSportOrder.length;
        list.innerHTML = _pendingSportOrder.map(function(key, idx) {
            var sport = SPORTS.find(function(s) { return s.key === key; });
            if (!sport) return '';
            var locked = !pro && FREE_SPORTS.indexOf(key) === -1;
            return '<div class="sort-drag-item' + (locked ? ' sort-locked' : '') + '" data-idx="' + idx + '">'
                + '<span class="sort-drag-handle">⠿</span>'
                + '<span style="flex:1">' + escHtml(sport.label) + (locked ? ' 🔒' : '') + '</span>'
                + '<button class="sort-arrow-btn" onclick="sortMove(' + idx + ',-1)" ' + (idx === 0 ? 'disabled' : '') + '>↑</button>'
                + '<button class="sort-arrow-btn" onclick="sortMove(' + idx + ',1)" ' + (idx === n - 1 ? 'disabled' : '') + '>↓</button>'
                + '</div>';
        }).join('');
        Array.from(list.querySelectorAll('.sort-drag-handle')).forEach(function(handle, idx) {
            handle.addEventListener('pointerdown', function(e) {
                e.preventDefault();
                startSortDrag(e, idx);
                document.addEventListener('pointermove', onSortPointerMove, { passive: false });
                document.addEventListener('pointerup', onSortPointerUp, { once: true });
            });
        });
    }

    function sortMove(idx, dir) {
        var n = idx + dir;
        if (!_pendingSportOrder || n < 0 || n >= _pendingSportOrder.length) return;
        var a = _pendingSportOrder.slice();
        var t = a[idx]; a[idx] = a[n]; a[n] = t;
        _pendingSportOrder = a;
        renderSortList();
    }

    var _upgradeBilling = 'monthly';

    function setUpgradeBilling(plan) {
        _upgradeBilling = plan;
        var isAnnual = plan === 'annual';
        var trialEligible = currentUser && !currentUser.had_free_trial;
        var mBtn = document.getElementById('toggle-monthly');
        var aBtn = document.getElementById('toggle-annual');
        if (mBtn) { mBtn.style.background = isAnnual ? 'var(--bg3)' : 'var(--accent)'; mBtn.style.color = isAnnual ? 'var(--muted)' : '#fff'; }
        if (aBtn) { aBtn.style.background = isAnnual ? 'var(--accent)' : 'var(--bg3)'; aBtn.style.color = isAnnual ? '#fff' : 'var(--muted)'; }
        var callout = document.getElementById('upgrade-trial-callout');
        if (callout) callout.style.display = (!isAnnual && trialEligible) ? 'block' : 'none';
        var note = document.getElementById('upgrade-trial-note');
        if (note) note.textContent = isAnnual ? '$39 billed annually — cancel anytime' : 'Then billed monthly — cancel anytime';
        var btn = document.getElementById('upgrade-btn');
        if (btn) btn.textContent = isAnnual ? 'Upgrade Annually — $39/yr →' : (trialEligible ? 'Start 14-Day Free Trial →' : 'Upgrade to Pro →');
    }

    async function startCheckout() {
        var btn = document.getElementById('upgrade-btn');
        var isAnnual = _upgradeBilling === 'annual';
        var trialEligible = !isAnnual && currentUser && !currentUser.had_free_trial;
        try { posthog.capture('checkout_started', { trial_eligible: !!trialEligible, billing: _upgradeBilling }); } catch(e) {}
        var defaultLabel = isAnnual ? 'Upgrade Annually — $39/yr →' : (trialEligible ? 'Start 14-Day Free Trial →' : 'Upgrade to Pro →');
        btn.textContent = 'Redirecting...';
        btn.disabled = true;
        try {
            var refCode = (document.getElementById('upgrade-referral-code').value || '').trim().toUpperCase();
            var res = await fetch('/api/stripe/checkout', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ referral_code: refCode || null, billing: _upgradeBilling })
            });
            var data = await res.json();
            if (data.url) {
                window.location.assign(data.url);
            } else {
                btn.textContent = defaultLabel;
                btn.disabled = false;
                showToast(data.error || 'Something went wrong. Please try again.', 'error');
            }
        } catch (e) {
            btn.textContent = defaultLabel;
            btn.disabled = false;
            showToast('Network error -- please try again.', 'error');
        }
    }

    async function openBillingPortal() {
        try { posthog.capture('billing_portal_opened'); } catch(e) {}
        var res = await fetch('/api/stripe/portal', { method: 'POST', credentials: 'same-origin' });
        var data = await res.json();
        if (data.url) window.location.href = data.url;
    }

    function handleCheckoutReturn() {
        var params = new URLSearchParams(window.location.search);
        if (params.get('checkout') === 'success') {
            history.replaceState({}, '', '/');
            // sync-plan reads from Stripe directly (bypasses D1 replica lag),
            // force-writes plan='pro' to D1 so subsequent /api/auth/me reads see it.
            async function syncThenPoll() {
                try {
                    var syncRes = await fetch('/api/stripe/sync-plan', { credentials: 'same-origin' });
                    var syncData = await syncRes.json();
                    if (syncData.plan === 'pro') {
                        await checkSession();
                        return; // success — no modal
                    }
                } catch(e) {}

                // sync-plan returned free — poll /api/auth/me for up to 12s
                // (webhook may still be in flight)
                var attempts = 0;
                var maxAttempts = 8;
                async function pollForPro() {
                    await checkSession();
                    if (currentUser && currentUser.plan === 'pro') return;
                    attempts++;
                    if (attempts < maxAttempts) {
                        setTimeout(pollForPro, 1500);
                    } else {
                        if (currentUser && currentUser.plan !== 'pro') showTrialBlockedModal();
                    }
                }
                setTimeout(pollForPro, 1500);
            }
            setTimeout(syncThenPoll, 2000);
        } else if (params.get('checkout') === 'cancel') {
            history.replaceState({}, '', '/');
        }
    }

    function showTrialBlockedModal() {
        var modal = document.getElementById('trial-blocked-modal');
        if (modal) modal.style.display = 'flex';
    }
    function closeTrialBlockedModal() {
        var modal = document.getElementById('trial-blocked-modal');
        if (modal) modal.style.display = 'none';
    }

    function showUpgradeModal(msg, billing) {
        try { posthog.capture('upgrade_modal_shown', { trigger: msg, sport: currentSport }); } catch(e) {}
        document.getElementById('upgrade-msg').textContent = msg;
        document.getElementById('upgrade-modal').style.display = 'flex';
        document.getElementById('upgrade-btn').disabled = false;
        // Reset referral section
        var wrap = document.getElementById('upgrade-referral-wrap');
        var inp  = document.getElementById('upgrade-referral-code');
        var codeBtn = document.getElementById('upgrade-code-btn');
        if (wrap) wrap.style.display = 'none';
        if (inp)  inp.value = '';
        if (codeBtn) codeBtn.textContent = 'Have a code?';
        setUpgradeBilling(billing || 'monthly');
    }
    function closeUpgradeModal() {
        document.getElementById('upgrade-modal').style.display = 'none';
        try { posthog.capture('upgrade_modal_dismissed', { sport: currentSport }); } catch(e) {}
    }

    // Annual upsell entry point — free users go to checkout (annual pre-selected),
    // monthly pro users see the proration confirmation modal.
    function openAnnualUpsell() {
        if (!currentUser) return;
        if (currentUser.plan !== 'pro') {
            showUpgradeModal('Get full access to all sports, markets, and EV tools.', 'annual');
            return;
        }
        // Monthly pro — show proration modal
        showAnnualUpgradeModal();
    }

    async function showAnnualUpgradeModal() {
        var modal    = document.getElementById('annual-upgrade-modal');
        var loading  = document.getElementById('annual-upgrade-loading');
        var details  = document.getElementById('annual-upgrade-details');
        var errEl    = document.getElementById('annual-upgrade-error');
        var amountEl = document.getElementById('annual-amount-due');
        var btn      = document.getElementById('annual-upgrade-btn');
        if (!modal) return;
        // Reset state
        loading.style.display = 'block';
        details.style.display = 'none';
        errEl.style.display = 'none';
        btn.disabled = false;
        btn.textContent = 'Confirm Upgrade →';
        modal.style.display = 'flex';
        try {
            var res  = await fetch('/api/stripe/upgrade-preview', { credentials: 'same-origin' });
            var data = await res.json();
            loading.style.display = 'none';
            if (!data.ok) {
                errEl.textContent = data.error === 'already_annual' ? 'You are already on the annual plan.' : (data.error || 'Could not load preview.');
                errEl.style.display = 'block';
                btn.disabled = true;
                return;
            }
            amountEl.textContent = data.amountDueStr;
            details.style.display = 'block';
        } catch(e) {
            loading.style.display = 'none';
            errEl.textContent = 'Network error — please try again.';
            errEl.style.display = 'block';
            btn.disabled = true;
        }
    }

    function closeAnnualUpgradeModal() {
        var modal = document.getElementById('annual-upgrade-modal');
        if (modal) modal.style.display = 'none';
    }

    async function confirmAnnualUpgrade() {
        var btn   = document.getElementById('annual-upgrade-btn');
        var errEl = document.getElementById('annual-upgrade-error');
        btn.disabled = true;
        btn.textContent = 'Upgrading...';
        errEl.style.display = 'none';
        try {
            var res  = await fetch('/api/stripe/upgrade', { method: 'POST', credentials: 'same-origin' });
            var data = await res.json();
            if (data.ok) {
                try { posthog.capture('annual_upgrade_completed'); } catch(e) {}
                closeAnnualUpgradeModal();
                await checkSession();
                showToast('Upgraded to Annual plan! You save $20.88/yr.', 'success');
            } else {
                errEl.textContent = data.error || 'Upgrade failed — please try again.';
                errEl.style.display = 'block';
                btn.disabled = false;
                btn.textContent = 'Confirm Upgrade →';
            }
        } catch(e) {
            errEl.textContent = 'Network error — please try again.';
            errEl.style.display = 'block';
            btn.disabled = false;
            btn.textContent = 'Confirm Upgrade →';
        }
    }

    function showTrialNudge(user) {
        var banner = document.getElementById('trial-nudge-banner');
        var msg    = document.getElementById('trial-nudge-msg');
        if (!banner || !msg) return;
        // Only nudge users who cancelled their trial — active subs auto-renew, no action needed
        if (user.plan !== 'pro' || !user.had_free_trial || !user.pro_expires_at || user.stripe_sub_id) { banner.style.display = 'none'; return; }
        var now      = Math.floor(Date.now() / 1000);
        var secsLeft = user.pro_expires_at - now;
        if (secsLeft <= 0 || secsLeft > 3 * 86400) { banner.style.display = 'none'; return; }
        var daysLeft = Math.ceil(secsLeft / 86400);
        var dayLabel = daysLeft === 1 ? '1 day' : daysLeft + ' days';
        msg.textContent = 'Your trial ends in ' + dayLabel + ' — resubscribe to keep access.';
        banner.style.display = 'block';
    }

    function toggleReferralInput() {
        var wrap = document.getElementById('upgrade-referral-wrap');
        var btn  = document.getElementById('upgrade-code-btn');
        var open = wrap.style.display === 'none' || wrap.style.display === '';
        wrap.style.display = open ? 'block' : 'none';
        btn.textContent = open ? 'Remove code' : 'Have a code?';
        if (open) document.getElementById('upgrade-referral-code').focus();
    }

    function buildTabs() {
        var nav = document.getElementById('sport-tabs');
        nav.innerHTML = '';
        var pro = isPro();

        // Admin setup: show api-remaining and ensure admin tab button exists
        var adminBtn = null;
        if (currentUser && currentUser.is_admin) {
            document.getElementById('api-remaining').style.display = '';
            adminBtn = document.getElementById('admin-tab-btn');
            if (!adminBtn) {
                adminBtn = document.createElement('button');
                adminBtn.className = 'sport-tab';
                adminBtn.textContent = ' Admin';
                adminBtn.style.cssText = 'color:var(--accent);margin-left:auto';
                adminBtn.id = 'admin-tab-btn';
                adminBtn.onclick = function() {
                    var isActive = this.classList.contains('active');
                    if (isActive) {
                        this.classList.remove('active');
                        this.textContent = ' Admin';
                        hideAdminTab();
                        loadOdds();
                    } else {
                        document.querySelectorAll('.sport-tab').forEach(function(t) {
                            t.classList.remove('active');
                        });
                        this.classList.add('active');
                        this.textContent = '<- Dashboard';
                        showAdminTab();
                    }
                };
            }
        }

        orderedSports().forEach(function(s) {
            var locked = !pro && FREE_SPORTS.indexOf(s.key) === -1;
            var b = document.createElement('button');
            b.className = 'sport-tab' + (s.key === currentSport && !locked ? ' active' : '') + (locked ? ' locked' : '');
            b.textContent = (locked ? ' ' : '') + s.label;
            b.setAttribute('data-key', s.key);
            b.onclick = function() {
                if (locked) {
                    showUpgradeModal(s.label + ' is a Pro feature. Upgrade to unlock all 7 sports — NCAAB, NHL, UFC, FC, spreads, totals, and more.');
                    return;
                }
                currentSport = s.key;
                try { posthog.capture('sport_tab_opened', { sport: s.key, label: s.label }); } catch(e) {}
                document.querySelectorAll('.sport-tab,.feature-tab').forEach(function(x) {
                    x.classList.toggle('active', x.getAttribute('data-key') === s.key);
                });
                if (s.key === 'soccer_fc') {
                    currentFcLeague = 'ALL';
                    buildFcLeagueNav();
                    document.getElementById('fc-league-nav').style.display = 'flex';
                    document.getElementById('wc-sub-nav').style.display = 'none';
                    showWcFuturesPanel(false);
                } else if (s.key === 'soccer_wc') {
                    document.getElementById('fc-league-nav').style.display = 'none';
                    wcSubTab = 'games';
                    buildWcSubNav();
                    document.getElementById('wc-sub-nav').style.display = 'flex';
                    showWcFuturesPanel(false);
                } else {
                    document.getElementById('fc-league-nav').style.display = 'none';
                    document.getElementById('wc-sub-nav').style.display = 'none';
                    showWcFuturesPanel(false);
                }
                loadOdds();
                startScoresPoller(s.key);
            };
            nav.appendChild(b);
        });
        if (adminBtn) nav.appendChild(adminBtn);

        // ── Feature tabs bar (Best EV / Portfolio / Refer) ──────────────
        var ftBar = document.getElementById('feature-tabs');
        if (ftBar) {
            // Best EV tab — visible to all, pro-gated on click for free users
            if (!document.getElementById('ev-tab-btn')) {
                var evTabBtn = document.createElement('button');
                evTabBtn.className = 'feature-tab sport-tab';
                evTabBtn.textContent = '⚡ Best EV';
                evTabBtn.id = 'ev-tab-btn';
                if (isPro()) {
                    evTabBtn.style.cssText = 'color:var(--yellow);font-weight:700;opacity:0.45;cursor:not-allowed';
                    evTabBtn.disabled = true;
                    evTabBtn.title = 'Loading all sports…';
                } else {
                    evTabBtn.style.cssText = 'color:var(--yellow);font-weight:700';
                    evTabBtn.title = 'Pro feature';
                }
                evTabBtn.onclick = function() {
                    if (!isPro()) {
                        showUpgradeModal('⚡ Best EV shows the highest positive-EV bets across all sports simultaneously. Upgrade to Pro to unlock it.');
                        return;
                    }
                    var isActive = this.classList.contains('active');
                    if (isActive) {
                        this.classList.remove('active');
                        this.textContent = '⚡ Best EV';
                        hideEvTab();
                        loadOdds();
                    } else {
                        document.querySelectorAll('.sport-tab,.feature-tab').forEach(function(t) { t.classList.remove('active'); });
                        this.classList.add('active');
                        this.textContent = '<- Dashboard';
                        showEvTab();
                    }
                };
                ftBar.appendChild(evTabBtn);
            } else {
                ftBar.appendChild(document.getElementById('ev-tab-btn'));
            }

            // Portfolio tab
            if (!document.getElementById('portfolio-tab-btn')) {
                var portTabBtn = document.createElement('button');
                portTabBtn.className = 'feature-tab sport-tab';
                portTabBtn.textContent = '📊 Portfolio';
                portTabBtn.id = 'portfolio-tab-btn';
                portTabBtn.onclick = function() {
                    var isActive = this.classList.contains('active');
                    if (isActive) {
                        this.classList.remove('active');
                        this.textContent = '📊 Portfolio';
                        hidePortfolioTab();
                        loadOdds();
                    } else {
                        document.querySelectorAll('.sport-tab,.feature-tab').forEach(function(t) { t.classList.remove('active'); });
                        this.classList.add('active');
                        this.textContent = '<- Dashboard';
                        showPortfolioTab();
                    }
                };
                ftBar.appendChild(portTabBtn);
            } else {
                ftBar.appendChild(document.getElementById('portfolio-tab-btn'));
            }


            // Referral tab — recreate since innerHTML wipe destroys it
            if (!document.getElementById('referral-tab-btn')) {
                var refTabBtn = document.createElement('button');
                refTabBtn.className = 'feature-tab sport-tab';
                refTabBtn.textContent = '🎁 Refer';
                refTabBtn.style.cssText = 'color:var(--green)';
                refTabBtn.id = 'referral-tab-btn';
                refTabBtn.onclick = function() {
                    var isActive = this.classList.contains('active');
                    if (isActive) {
                        this.classList.remove('active');
                        this.textContent = '🎁 Refer';
                        hideReferralTab();
                        loadOdds();
                    } else {
                        document.querySelectorAll('.sport-tab,.feature-tab').forEach(function(t) { t.classList.remove('active'); });
                        this.classList.add('active');
                        this.textContent = '<- Dashboard';
                        showReferralTab();
                    }
                };
                ftBar.appendChild(refTabBtn);
            } else {
                ftBar.appendChild(document.getElementById('referral-tab-btn'));
            }

            // OTD tab
            if (!document.getElementById('otd-tab-btn')) {
                var otdTabBtn = document.createElement('button');
                otdTabBtn.className = 'feature-tab sport-tab';
                otdTabBtn.textContent = '🗓️ OTD';
                otdTabBtn.id = 'otd-tab-btn';
                otdTabBtn.onclick = function() {
                    var isActive = this.classList.contains('active');
                    if (isActive) {
                        this.classList.remove('active');
                        this.textContent = '🗓️ OTD';
                        hideOtdTab();
                        loadOdds();
                    } else {
                        document.querySelectorAll('.sport-tab,.feature-tab').forEach(function(t) { t.classList.remove('active'); });
                        this.classList.add('active');
                        this.textContent = '<- Dashboard';
                        showOtdTab();
                    }
                };
                ftBar.appendChild(otdTabBtn);
            } else {
                ftBar.appendChild(document.getElementById('otd-tab-btn'));
            }

            // Pro ✦ button (manage subscription) — right of Refer, only for pro users
            if (currentUser && currentUser.plan === 'pro' && !currentUser.is_admin) {
                var existingProBtn = document.getElementById('manage-sub-btn');
                var isAnnualUser = currentUser.billing_interval === 'annual';
                if (!existingProBtn) {
                    var proBtn = document.createElement('button');
                    proBtn.id = 'manage-sub-btn';
                    proBtn.className = 'sport-tab';
                    proBtn.textContent = isAnnualUser ? 'Pro ✦ Annual' : 'Pro ✦';
                    proBtn.style.cssText = 'color:var(--accent);border-bottom-color:transparent;margin-left:auto';
                    proBtn.onclick = openBillingPortal;
                    ftBar.appendChild(proBtn);
                } else {
                    existingProBtn.textContent = isAnnualUser ? 'Pro ✦ Annual' : 'Pro ✦';
                    existingProBtn.style.marginLeft = 'auto';
                    ftBar.appendChild(existingProBtn);
                }
            }

            // Annual upsell button — free users and monthly pro users
            var showAnnualBtn = currentUser && !currentUser.is_admin && (
                currentUser.plan !== 'pro' || currentUser.billing_interval === 'monthly'
            );
            if (showAnnualBtn) {
                var existingAnnBtn = document.getElementById('annual-upsell-btn');
                if (!existingAnnBtn) {
                    var annBtn = document.createElement('button');
                    annBtn.id = 'annual-upsell-btn';
                    annBtn.className = 'sport-tab';
                    annBtn.style.cssText = 'color:var(--green);border-bottom-color:transparent;font-size:11px;' +
                        (currentUser.plan !== 'pro' ? 'margin-left:auto' : 'margin-left:6px');
                    annBtn.textContent = 'Annual · $39/yr · Save $21';
                    annBtn.onclick = function() { openAnnualUpsell(); };
                    ftBar.appendChild(annBtn);
                } else {
                    existingAnnBtn.style.marginLeft = currentUser.plan !== 'pro' ? 'auto' : '6px';
                    ftBar.appendChild(existingAnnBtn);
                }
            } else {
                var staleAnnBtn = document.getElementById('annual-upsell-btn');
                if (staleAnnBtn) staleAnnBtn.remove();
            }
        }

        // Init WC sub-nav visibility on page load (click handlers cover tab switches,
        // but buildTabs() is also called on initial load when currentSport may already be soccer_wc)
        var wcNav = document.getElementById('wc-sub-nav');
        if (wcNav) {
            if (currentSport === 'soccer_wc') {
                buildWcSubNav();
                wcNav.style.display = 'flex';
            } else {
                wcNav.style.display = 'none';
            }
        }
    }

    function parseGames(games) {
        var rows = [];
        var seen = {};
        games = games.filter(function(g) {
            var key = g.away_team + '@' + g.home_team;
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        });
        function filterOutcomes(outcomes, mk) {
            if (mk === 'h2h' && outcomes.length === 3)
                return outcomes.filter(function(o) { return o.name.toLowerCase() !== 'draw'; });
            return outcomes;
        }
        games.forEach(function(g) {
            var books = g.bookmakers || [];
            if (!books.length) return;
            var fd = books.find(function(b) { return b.key === 'fanduel'; });
            // Live games: FD suspends markets — fall back to DK so ML can still show.
            // Spread/Total rows with mismatched DK live lines get filtered out downstream.
            if (!fd && g.commence_time && new Date(g.commence_time) <= new Date()) {
                fd = books.find(function(b) { return b.key === 'draftkings'; });
            }
            if (!fd) return;
            // For MMA, only show today's fights
            if (currentSport === 'mma_mixed_martial_arts' && g.commence_time) {
                var gameDate = new Date(g.commence_time).toDateString();
                var today = new Date().toDateString();
                if (gameDate !== today) return;
            }
            (fd.markets || []).forEach(function(fdMkt) {
                var mk = fdMkt.key;
                var outcomes = filterOutcomes(fdMkt.outcomes || [], mk);
                if (outcomes.length !== 2) return;
                var A = outcomes[0], B = outcomes[1];
                var lbl = mktLbl(mk);
                var gs = g.away_team + ' @ ' + g.home_team;
                var cm = g.commence_time ? new Date(g.commence_time) : null;
                var pid = g.id + '-' + mk;
                rows.push({ id: pid + '-A', game: gs, cm: cm, mkt: lbl, side: A.name, am: A.price, pt: A.point != null ? A.point : null, pid: pid, ps: 'A', gid: g.id });
                rows.push({ id: pid + '-B', game: gs, cm: cm, mkt: lbl, side: B.name, am: B.price, pt: B.point != null ? B.point : null, pid: pid, ps: 'B', gid: g.id });
            });
        });
        return rows;
    }

    function resetRefreshBtn() {
        var b = document.getElementById('refresh-btn');
        if (!b) return;
        b.disabled = false;
        b.classList.remove('refresh-btn-spinning');
        b.textContent = 'Refresh';
    }

    function loadOdds() {
        try { posthog.capture('refresh_clicked', { sport: currentSport }); } catch(e) {}
        loadBetsTaken(); // keep taken bets in sync across devices
        stopAllPollers();
        payoutRatios = {}; rsMarketIds = {}; rsOutcomeKeys = {};
        if (!isPro()) {
            currentSport = FREE_SPORTS.indexOf(currentSport) !== -1 ? currentSport : FREE_SPORTS[0];
            var mktEl = document.getElementById('mkt-filter');
            if (mktEl.value !== 'ML') { mktEl.value = 'ML'; }
        }
        if (currentSport === 'basketball_wnba') {
            var mktEl = document.getElementById('mkt-filter');
            if (mktEl && mktEl.value !== 'ML') { mktEl.value = 'ML'; }
        }
        var btn = document.getElementById('refresh-btn'),
            dot = document.getElementById('sdot'),
            stxt = document.getElementById('status-txt');
        var sp = SPORTS.find(function(s) { return s.key === currentSport; });
        var lbl = sp ? sp.label : currentSport;

        btn.disabled = true;
        btn.classList.add('refresh-btn-spinning');
        btn.textContent = 'Loading';
        dot.className = 'sdot loading';
        stxt.textContent = 'Fetching ' + lbl + '...';
        document.getElementById('tbody').innerHTML = '<tr class="state-row"><td colspan="13">Loading...</td></tr>';

        // NBA: use FD native API directly — no Odds API credits
        if (currentSport === 'basketball_nba') {
            altOdds = {};
            dkPreGameStore = {};
            fetch('/api/fd/nbaalts', { credentials: 'same-origin' })
            .then(function(r) {
                if (r.status === 401) {
                    dot.className = 'sdot error';
                    stxt.textContent = 'Session expired — please log in again.';
                    resetRefreshBtn();
                    handleUnauthenticated();
                    return Promise.reject('unauth');
                }
                return r.json();
            })
            .then(function(data) {
                if (!data.ok || !data.games) {
                    rawRows = []; rsGameIds = {};
                    dot.className = 'sdot error';
                    stxt.textContent = 'No NBA games right now';
                    return;
                }
                var rows = [];
                Object.entries(data.games).forEach(function([gameKey, game]) {
                    var away = game.away, home = game.home;
                    var cm = game.cm ? new Date(game.cm) : null;
                    var gid = String(game.id);
                    altOdds[gid] = game;

                    if (game.spreads) {
                        var pid = gid + '-spreads';
                        [[away, 'A'], [home, 'B']].forEach(function(pair) {
                            var teamName = pair[0], ps = pair[1];
                            var sideData = game.spreads[teamName];
                            if (!sideData) return;
                            var entry = Object.entries(sideData)[0];
                            if (!entry) return;
                            rows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'Spread', side: teamName, am: entry[1], pt: parseFloat(entry[0]), pid: pid, ps: ps, gid: gid });
                        });
                    }
                    if (game.totals) {
                        var pid = gid + '-totals';
                        [['Over', 'A'], ['Under', 'B']].forEach(function(pair) {
                            var side = pair[0], ps = pair[1];
                            var sideData = game.totals[side];
                            if (!sideData) return;
                            var entry = Object.entries(sideData)[0];
                            if (!entry) return;
                            rows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'Total', side: side, am: entry[1], pt: parseFloat(entry[0]), pid: pid, ps: ps, gid: gid });
                        });
                    }
                    if (game.ml) {
                        var pid = gid + '-h2h';
                        [[away, 'A'], [home, 'B']].forEach(function(pair) {
                            var teamName = pair[0], ps = pair[1];
                            var price = game.ml[teamName];
                            if (price == null) return;
                            rows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid });
                        });
                    }
                });
                rawRows = rows;
                rawRowsBySport[currentSport] = rawRows;
                var nowStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
                if (rawRows.length) {
                    dot.className = 'sdot live';
                    stxt.textContent = 'Updated ' + nowStr + ' - ' + Object.keys(data.games).length + ' games - FanDuel';
                } else {
                    dot.className = 'sdot error';
                    stxt.textContent = 'No NBA games right now';
                }
            })
            .catch(function(e) {
                if (e === 'unauth') return;
                rawRows = []; rsGameIds = {};
                dot.className = 'sdot error';
                stxt.textContent = 'Error fetching NBA data';
            })
            .then(function() {
                resetRefreshBtn();
                if (rawRows.length > 0) {
                    fetchRealMarkets(currentSport).then(function() { fetchExactEvForRows(currentSport); }).catch(function() { renderTable(); });
                } else { renderTable(); }

                // Start auto-poll to keep NBA odds live
                if (nbaPoller) clearInterval(nbaPoller);
                nbaPoller = setInterval(function() {
                    if (currentSport !== 'basketball_nba') { clearInterval(nbaPoller); nbaPoller = null; return; }
                    if (document.hidden) return;
                    fetchAltLinesForNBA();
                }, 5000);
                // Fetch DK alt lines once on load, then every 30s
                fetchDKAltLines();
                if (dkPoller) clearInterval(dkPoller);
                dkPoller = setInterval(function() {
                    if (currentSport !== 'basketball_nba') { clearInterval(dkPoller); dkPoller = null; return; }
                    if (document.hidden) return;
                    fetchDKAltLines();
                }, 5000);
            });
            return;
        }

        // WNBA: use FD native API directly — no Odds API credits
        if (currentSport === 'basketball_wnba') {
            altOdds = {};
            dkPreGameStore = {};
            fetch('/api/fd/wnbaalts', { credentials: 'same-origin' })
            .then(function(r) {
                if (r.status === 401) {
                    dot.className = 'sdot error';
                    stxt.textContent = 'Session expired — please log in again.';
                    resetRefreshBtn();
                    handleUnauthenticated();
                    return Promise.reject('unauth');
                }
                return r.json();
            })
            .then(function(data) {
                if (!data.ok || !data.games) {
                    rawRows = []; rsGameIds = {};
                    dot.className = 'sdot error';
                    stxt.textContent = 'No WNBA games right now';
                    return;
                }
                var rows = [];
                Object.entries(data.games).forEach(function([gameKey, game]) {
                    var away = game.away, home = game.home;
                    var cm = game.cm ? new Date(game.cm) : null;
                    var gid = String(game.id);
                    altOdds[gid] = game;

                    if (game.ml) {
                        var pid = gid + '-h2h';
                        [[away, 'A'], [home, 'B']].forEach(function(pair) {
                            var teamName = pair[0], ps = pair[1];
                            var price = game.ml[teamName];
                            if (price == null) return;
                            rows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid });
                        });
                    }
                });
                rawRows = rows;
                rawRowsBySport[currentSport] = rawRows;
                var nowStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
                if (rawRows.length) {
                    dot.className = 'sdot live';
                    stxt.textContent = 'Updated ' + nowStr + ' - ' + Object.keys(data.games).length + ' games - FanDuel';
                } else {
                    dot.className = 'sdot error';
                    stxt.textContent = 'No WNBA games right now';
                }
            })
            .catch(function(e) {
                if (e === 'unauth') return;
                rawRows = []; rsGameIds = {};
                dot.className = 'sdot error';
                stxt.textContent = 'Error fetching WNBA data';
            })
            .then(function() {
                resetRefreshBtn();
                if (rawRows.length > 0) {
                    fetchRealMarkets(currentSport).then(function() { fetchExactEvForRows(currentSport); }).catch(function() { renderTable(); });
                } else { renderTable(); }

                // Start auto-poll to keep WNBA odds live
                if (wnbaPoller) clearInterval(wnbaPoller);
                wnbaPoller = setInterval(function() {
                    if (currentSport !== 'basketball_wnba') { clearInterval(wnbaPoller); wnbaPoller = null; return; }
                    if (document.hidden) return;
                    fetchAltLinesForWNBA();
                }, 5000);
            });
            return;
        }

        // Stop all native pollers when switching sports
        if (nbaPoller)  { clearInterval(nbaPoller);  nbaPoller  = null; }
        if (wnbaPoller) { clearInterval(wnbaPoller); wnbaPoller = null; }
        if (mlbPoller)  { clearInterval(mlbPoller);  mlbPoller  = null; }
        if (nhlPoller)  { clearInterval(nhlPoller);  nhlPoller  = null; }
        if (dkPoller)  { clearInterval(dkPoller);  dkPoller  = null; }
        if (fcPoller)  { clearInterval(fcPoller);  fcPoller  = null; }
        if (wcPoller)  { clearInterval(wcPoller);  wcPoller  = null; }
        dkAltOdds = {};

        // WC Futures sub-tab
        if (currentSport === 'soccer_wc' && wcSubTab === 'futures') {
            showWcFuturesPanel(true);
            loadWcFutures();
            resetRefreshBtn();
            return;
        }

        // WC KO: DK "To Advance" (subcat 5826) — 2-way ML, includes ET + pens
        if (currentSport === 'soccer_wc') {
            showWcFuturesPanel(false);
            altOdds = {};
            rawRows = [];
            fetch('/api/fd/wc?fresh=1', { credentials: 'same-origin' })
            .then(function(r) {
                if (r.status === 401) {
                    dot.className = 'sdot error';
                    stxt.textContent = 'Session expired — please log in again.';
                    resetRefreshBtn();
                    handleUnauthenticated();
                    return Promise.reject('unauth');
                }
                return r.json();
            })
            .then(function(data) {
                if (!data.ok || !data.games) {
                    rawRows = []; rsGameIds = {};
                    dot.className = 'sdot error';
                    stxt.textContent = 'No WC games right now';
                    return;
                }
                var rows = [];
                Object.entries(data.games).forEach(function([gameKey, game]) {
                    var away = game.away, home = game.home;
                    var cm = game.cm ? new Date(game.cm) : null;
                    var gid = String(game.id);
                    var pid = gid + '-ta';
                    [[away, 'A', game.away_ml], [home, 'B', game.home_ml]].forEach(function(triple) {
                        var teamName = triple[0], ps = triple[1], am = triple[2];
                        if (am == null) return;
                        rows.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName,
                            am: am, pt: null, pid: pid, ps: ps, gid: gid, league: game.league || '',
                            _sport_key: 'soccer_wc' });
                    });
                });
                rawRows = rows;
                rawRowsBySport[currentSport] = rawRows;
                var nowStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
                if (rawRows.length) {
                    dot.className = 'sdot live';
                    stxt.textContent = 'Updated ' + nowStr + ' - ' + Object.keys(data.games).length + ' games - DraftKings';
                } else {
                    dot.className = 'sdot error';
                    stxt.textContent = 'No WC games right now';
                }
            })
            .catch(function(e) {
                if (e === 'unauth') return;
                rawRows = []; rsGameIds = {};
                dot.className = 'sdot error';
                stxt.textContent = 'Error fetching WC data';
            })
            .then(function() {
                resetRefreshBtn();
                if (rawRows.length > 0) {
                    fetchRealMarkets(currentSport).then(function() { fetchExactEvForRows(currentSport); }).catch(function() { renderTable(); });
                } else { renderTable(); }

                if (wcPoller) clearInterval(wcPoller);
                wcPoller = setInterval(function() {
                    if (currentSport !== 'soccer_wc' || wcSubTab !== 'games' || evTabVisible) { clearInterval(wcPoller); wcPoller = null; return; }
                    if (document.hidden) return;
                    fetchWCNativeUpdate();
                }, 5000);
            });
            return;
        }

        // FC: use FD native API for soccer ML — no Odds API credits
        if (currentSport === 'soccer_fc') {
            altOdds = {};
            rawRows = []; // clear before async fetch — prevents in-flight pollers/RS sync from flashing stale data
            fetch('/api/fd/fc?fresh=1', { credentials: 'same-origin' }) // ?fresh=1: bypass server cache so initial load always gets live DK prices
            .then(function(r) {
                if (r.status === 401) {
                    dot.className = 'sdot error';
                    stxt.textContent = 'Session expired — please log in again.';
                    resetRefreshBtn();
                    handleUnauthenticated();
                    return Promise.reject('unauth');
                }
                return r.json();
            })
            .then(function(data) {
                if (!data.ok || !data.games) {
                    rawRows = []; rsGameIds = {};
                    dot.className = 'sdot error';
                    stxt.textContent = 'No FC games right now';
                    return;
                }
                var rows = [];
                Object.entries(data.games).forEach(function([gameKey, game]) {
                    var away = game.away, home = game.home;
                    var cm = game.cm ? new Date(game.cm) : null;
                    var gid = String(game.id);
                    var pid = gid + '-h2h';
                    // Determine correct ±0.5 pairing using DK prices.
                    // Lower American odds for the -0.5 line = more likely to win = DK's -0.5 team.
                    // This ensures the initial display is always a proper -0.5/+0.5 pair, not -0.5/-0.5.
                    var awayGetsMinus;
                    if (game.awm != null && game.hm != null) {
                        awayGetsMinus = game.awm <= game.hm;
                    } else if (game.awm != null) { awayGetsMinus = true; }
                    else { awayGetsMinus = false; }
                    [[away, 'A'], [home, 'B']].forEach(function(pair) {
                        var teamName = pair[0], ps = pair[1];
                        var isAway = ps === 'A';
                        var isMinus = isAway ? awayGetsMinus : !awayGetsMinus;
                        var initAm = isMinus ? (isAway ? game.awm : game.hm) : (isAway ? game.awp : game.hp);
                        var initPt = isMinus ? -0.5 : 0.5;
                        if (initAm == null) return;
                        rows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'Spread', side: teamName,
                            am: initAm, pt: initPt, pid: pid, ps: ps, gid: gid, league: game.league || '',
                            _dkSpreads: game.spreads || { Home: {}, Away: {} } });
                    });
                });
                rawRows = rows;
                rawRowsBySport[currentSport] = rawRows;
                var nowStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
                if (rawRows.length) {
                    dot.className = 'sdot live';
                    stxt.textContent = 'Updated ' + nowStr + ' - ' + Object.keys(data.games).length + ' games - DraftKings';
                } else {
                    dot.className = 'sdot error';
                    stxt.textContent = 'No FC games right now';
                }
            })
            .catch(function(e) {
                if (e === 'unauth') return;
                rawRows = []; rsGameIds = {};
                dot.className = 'sdot error';
                stxt.textContent = 'Error fetching FC data';
            })
            .then(function() {
                resetRefreshBtn();
                if (rawRows.length > 0) {
                    fetchRealMarkets(currentSport).then(function() { fetchExactEvForRows(currentSport); }).catch(function() { renderTable(); });
                } else { renderTable(); }

                if (fcPoller) clearInterval(fcPoller);
                fcPoller = setInterval(function() {
                    if (currentSport !== 'soccer_fc') { clearInterval(fcPoller); fcPoller = null; return; }
                    if (document.hidden) return;
                    fetchFCNativeUpdate();
                }, 5000);
            });
            return;
        }

        // MLB: use FD native API for ML — no Odds API credits
        if (currentSport === 'baseball_mlb') {
            altOdds = {};
            currentLoadAbort = new AbortController();
            var mlbSignal = currentLoadAbort.signal;
            fetch('/api/fd/mlb', { credentials: 'same-origin', signal: mlbSignal })
            .then(function(r) {
                if (r.status === 401) {
                    dot.className = 'sdot error';
                    stxt.textContent = 'Session expired — please log in again.';
                    resetRefreshBtn();
                    handleUnauthenticated();
                    return Promise.reject('unauth');
                }
                return r.json();
            })
            .then(function(data) {
                if (!data.ok || !data.games) {
                    rawRows = []; rsGameIds = {};
                    dot.className = 'sdot error';
                    stxt.textContent = 'No MLB games right now';
                    return;
                }
                var rows = [];
                Object.entries(data.games).forEach(function([gameKey, game]) {
                    var away = game.away, home = game.home;
                    var cm = game.cm ? new Date(game.cm) : null;
                    var gid = String(game.id);
                    var pid = gid + '-h2h';
                    [[away, 'A'], [home, 'B']].forEach(function(pair) {
                        var teamName = pair[0], ps = pair[1];
                        var price = game.ml[teamName];
                        if (price == null) return;
                        rows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid });
                    });
                });
                rawRows = rows;
                rawRowsBySport[currentSport] = rawRows;
                var nowStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
                if (rawRows.length) {
                    dot.className = 'sdot live';
                    stxt.textContent = 'Updated ' + nowStr + ' - ' + Object.keys(data.games).length + ' games - FanDuel';
                } else {
                    dot.className = 'sdot error';
                    stxt.textContent = 'No MLB games right now';
                }
            })
            .catch(function(e) {
                if (e === 'unauth' || e.name === 'AbortError') return;
                rawRows = []; rsGameIds = {};
                dot.className = 'sdot error';
                stxt.textContent = 'Error fetching MLB data';
            })
            .then(function() {
                if (mlbSignal.aborted) return;
                resetRefreshBtn();
                if (rawRows.length > 0) {
                    // Defer render until RS preds + RFI both resolve — avoids preds→probsExact EV flicker
                    var rsPromise = fetchRealMarkets(currentSport, true);
                    var rfiPromise = fetchKalshiRFI(true); // skipRender — Promise.all handles the single render
                    Promise.all([rsPromise, rfiPromise]).then(function() {
                        // Now lastSyncData is populated — apply Real% to RFI rows
                        var syncD = lastSyncData[currentSport];
                        if (syncD && syncD.markets) {
                            var mKeys = Object.keys(syncD.markets);
                            rawRows.forEach(function(r) {
                                if (r.mkt !== 'RFI') return;
                                var realKey = syncD.markets[r.game] ? r.game : null;
                                if (!realKey) {
                                    // DH: translate FD "(Game N)" suffix to RS " (2)" format
                                    var _dhMl = r.game.match(/^(.+?)\s*\(Game (\d+)\)$/);
                                    if (_dhMl) {
                                        var _dhBl = _dhMl[1].trim(), _dhNl = parseInt(_dhMl[2]);
                                        if (_dhNl >= 2 && syncD.markets[_dhBl + ' (2)']) realKey = _dhBl + ' (2)';
                                        else if (_dhNl === 1 && syncD.markets[_dhBl]) realKey = _dhBl;
                                    }
                                }
                                if (!realKey) {
                                    var _gameBase = r.game.replace(/\s*\(Game \d+\)/, '').trim();
                                    var fdTeams = _gameBase.split(' @ ');
                                    var fdAway = (fdTeams[0] || '').toLowerCase();
                                    var fdHome = (fdTeams[1] || '').toLowerCase();
                                    var found = mKeys.find(function(k) {
                                        if (k.endsWith('__lines') || k.endsWith('__gid')) return false;
                                        var kBase = k.endsWith(' (2)') ? k.slice(0, -4) : k;
                                        var p = kBase.split(' @ ');
                                        if (p.length !== 2) return false;
                                        var ka = resolveTeamName(p[0].trim()).toLowerCase(), kh = resolveTeamName(p[1].trim()).toLowerCase();
                                        var awayOk = ka.split(' ').some(function(w) { return w.length > 2 && fdAway.indexOf(w) !== -1; }) || fdAway.split(' ').some(function(w) { return w.length > 2 && ka.indexOf(w) !== -1; });
                                        var homeOk = kh.split(' ').some(function(w) { return w.length > 2 && fdHome.indexOf(w) !== -1; }) || fdHome.split(' ').some(function(w) { return w.length > 2 && kh.indexOf(w) !== -1; });
                                        return awayOk && homeOk;
                                    });
                                    if (found) {
                                        var _isDH2 = /\(Game [2-9]/.test(r.game);
                                        if (_isDH2 && !found.endsWith(' (2)')) {
                                            if (mKeys.indexOf(found + ' (2)') !== -1) found = found + ' (2)';
                                            else found = null;
                                        }
                                        if (found) realKey = found;
                                    }
                                }
                                if (!realKey) return;
                                var gameMkts = syncD.markets[realKey];
                                if (!gameMkts) return;
                                var mktData = gameMkts['Run in 1st inning?'];
                                if (!mktData) return;
                                var outcomes = mktData.outcomes || mktData;
                                if (!outcomes || !outcomes.length) return;
                                var isYes = r.ps === 'A';
                                var match = outcomes.find(function(o) { if (!o.label) return false; return isYes ? o.label.toLowerCase() === 'yes' : o.label.toLowerCase() === 'no'; });
                                if (!match) match = isYes ? outcomes[1] : outcomes[0];
                                if (match && match.pct != null) {
                                    var pct = parseFloat(match.pct);
                                    var gameStarted = r.cm && r.cm.getTime() < Date.now();
                                    if (gameStarted && (pct <= 3 || pct >= 97)) return;
                                    preds[r.id] = String(match.pct); if (match.probability != null) probsExact[r.id] = match.probability; if (mktData.volumeDisplay) vols[r.id] = mktData.volumeDisplay;
                                }
                            });
                        }
                        renderTable();
                        fetchExactEvForRows(currentSport);
                    });
                    if (mlbPoller) clearInterval(mlbPoller);
                    mlbPoller = setInterval(function() {
                        if (currentSport !== 'baseball_mlb') { clearInterval(mlbPoller); mlbPoller = null; return; }
                        if (document.hidden) return;
                        fetchMLBNativeUpdate();
                    }, 5000);
                } else {
                    renderTable();
                }
            });
            return;
        }

        // CWS: DK native moneyline
        if (currentSport === 'baseball_cws') {
            altOdds = {};
            fetch('/api/dk/cws?fresh=1', { credentials: 'same-origin' })
            .then(function(r) {
                if (r.status === 401) { dot.className = 'sdot error'; stxt.textContent = 'Session expired — please log in again.'; resetRefreshBtn(); handleUnauthenticated(); return Promise.reject('unauth'); }
                return r.json();
            })
            .then(function(data) {
                if (!data.ok || !data.games || !Object.keys(data.games).length) {
                    rawRows = []; rsGameIds = {};
                    dot.className = 'sdot error'; stxt.textContent = 'No CWS games right now';
                    return;
                }
                var rows = [];
                Object.entries(data.games).forEach(function([gameKey, game]) {
                    var away = game.away, home = game.home;
                    var cm = game.cm ? new Date(game.cm) : null;
                    var gid = String(game.id);
                    var pid = gid + '-h2h';
                    if (game.awayOdds != null) rows.push({ id: pid + '-A', game: gameKey, cm: cm, mkt: 'ML', side: away, am: game.awayOdds, pt: null, pid: pid, ps: 'A', gid: gid });
                    if (game.homeOdds != null) rows.push({ id: pid + '-B', game: gameKey, cm: cm, mkt: 'ML', side: home, am: game.homeOdds, pt: null, pid: pid, ps: 'B', gid: gid });
                });
                rawRows = rows;
                rawRowsBySport[currentSport] = rawRows;
                var nowStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
                dot.className = rawRows.length ? 'sdot live' : 'sdot error';
                stxt.textContent = rawRows.length ? 'Updated ' + nowStr + ' - ' + Object.keys(data.games).length + ' games - DraftKings' : 'No CWS games right now';
            })
            .catch(function(e) {
                if (e === 'unauth') return;
                rawRows = []; rsGameIds = {};
                dot.className = 'sdot error'; stxt.textContent = 'Error fetching CWS data';
            })
            .then(function() {
                resetRefreshBtn();
                if (rawRows.length > 0) {
                    fetchRealMarkets(currentSport).then(function() { fetchExactEvForRows(currentSport); }).catch(function() { renderTable(); });
                } else { renderTable(); }
            });
            return;
        }

        // NHL: use FD native API — no Odds API credits
        if (currentSport === 'icehockey_nhl') {
            altOdds = {};
            dkPreGameStore = {};
            fetch('/api/fd/nhl', { credentials: 'same-origin' })
            .then(function(r) {
                if (r.status === 401) {
                    dot.className = 'sdot error';
                    stxt.textContent = 'Session expired — please log in again.';
                    resetRefreshBtn();
                    handleUnauthenticated();
                    return Promise.reject('unauth');
                }
                return r.json();
            })
            .then(function(data) {
                if (!data.ok || !data.games) {
                    rawRows = []; rsGameIds = {};
                    dot.className = 'sdot error';
                    stxt.textContent = 'No NHL games right now';
                    return;
                }
                var rows = [];
                Object.entries(data.games).forEach(function([gameKey, game]) {
                    var away = game.away, home = game.home;
                    var cm = game.cm ? new Date(game.cm) : null;
                    var gid = String(game.id);
                    altOdds[gid] = game;
                    if (game.spreads) {
                        var pid = gid + '-spreads';
                        [[away, 'A'], [home, 'B']].forEach(function(pair) {
                            var teamName = pair[0], ps = pair[1];
                            var sideData = game.spreads[teamName];
                            if (!sideData) return;
                            var entry = Object.entries(sideData)[0];
                            if (!entry) return;
                            rows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'Spread', side: teamName, am: entry[1], pt: parseFloat(entry[0]), pid: pid, ps: ps, gid: gid });
                        });
                    }
                    if (game.totals) {
                        var pid = gid + '-totals';
                        [['Over', 'A'], ['Under', 'B']].forEach(function(pair) {
                            var side = pair[0], ps = pair[1];
                            var sideData = game.totals[side];
                            if (!sideData) return;
                            var entry = Object.entries(sideData)[0];
                            if (!entry) return;
                            rows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'Total', side: side, am: entry[1], pt: parseFloat(entry[0]), pid: pid, ps: ps, gid: gid });
                        });
                    }
                    if (game.ml) {
                        var pid = gid + '-h2h';
                        [[away, 'A'], [home, 'B']].forEach(function(pair) {
                            var teamName = pair[0], ps = pair[1];
                            var price = game.ml[teamName];
                            if (price == null) return;
                            rows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid });
                        });
                    }
                });
                rawRows = rows;
                rawRowsBySport[currentSport] = rawRows;
                var nowStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
                if (rawRows.length) {
                    dot.className = 'sdot live';
                    stxt.textContent = 'Updated ' + nowStr + ' - ' + Object.keys(data.games).length + ' games - FanDuel';
                } else {
                    dot.className = 'sdot error';
                    stxt.textContent = 'No NHL games right now';
                }
            })
            .catch(function(e) {
                if (e === 'unauth') return;
                rawRows = []; rsGameIds = {};
                dot.className = 'sdot error';
                stxt.textContent = 'Error fetching NHL data';
            })
            .then(function() {
                resetRefreshBtn();
                if (rawRows.length > 0) {
                    fetchRealMarkets(currentSport).then(function() { fetchDKAltLinesNHL(); fetchExactEvForRows(currentSport); }).catch(function() { renderTable(); });
                    if (nhlPoller) clearInterval(nhlPoller);
                    nhlPoller = setInterval(function() {
                        if (currentSport !== 'icehockey_nhl') { clearInterval(nhlPoller); nhlPoller = null; return; }
                        if (document.hidden) return;
                        fetchNHLNativeUpdate();
                    }, 5000);
                    if (dkPoller) clearInterval(dkPoller);
                    dkPoller = setInterval(function() {
                        if (currentSport !== 'icehockey_nhl') { clearInterval(dkPoller); dkPoller = null; return; }
                        if (document.hidden) return;
                        fetchDKAltLinesNHL();
                    }, 5000);
                } else { renderTable(); }
            });
            return;
        }

        var sel = document.getElementById('mkt-filter').value;
        var noSpread = ['mma_mixed_martial_arts', 'baseball_mlb'];
        var mkts = noSpread.indexOf(currentSport) !== -1 ? 'h2h'
            : (!isPro()) ? 'h2h'
            : sel === 'ALL' ? 'h2h,spreads,totals' : (MARKET_KEYS[sel] || 'h2h');
        fetch('/api/odds?sport=' + currentSport + '&markets=' + mkts + '&bookmakers=fanduel')
        .then(function(r) {
            var rem = r.headers.get('x-requests-remaining');
            if (rem && rem !== 'cached') document.getElementById('api-remaining').textContent = rem + ' requests left';
            if (r.status === 401) {
                dot.className = 'sdot error';
                stxt.textContent = 'Session expired — please log in again.';
                resetRefreshBtn();
                handleUnauthenticated();
                return Promise.reject('unauth');
            }
            if (r.status === 429) {
                dot.className = 'sdot error';
                stxt.textContent = 'Daily refresh limit reached. Resets tomorrow.';
                resetRefreshBtn();
                return Promise.reject('rate');
            }
            if (r.status === 403) {
                return r.json().then(function(d) {
                    var msg = d && d.error ? d.error : '';
                    if (msg.toLowerCase().includes('suspended')) {
                        dot.className = 'sdot error';
                        stxt.textContent = 'Account suspended.';
                        return Promise.reject('banned');
                    }
                    // Plan restriction — show upgrade prompt, not "suspended"
                    dot.className = 'sdot error';
                    stxt.textContent = 'Pro required for this sport/market.';
                    resetRefreshBtn();
                    showUpgradeModal(msg || 'Upgrade to Pro to access this sport and market.');
                    return Promise.reject('banned');
                }).catch(function(e) {
                    if (e === 'banned') return Promise.reject('banned');
                    dot.className = 'sdot error';
                    stxt.textContent = 'Access denied.';
                    resetRefreshBtn();
                    return Promise.reject('banned');
                });
            }
            if (!r.ok && r.status !== 200) {
                return r.json().catch(function() { return { error: 'HTTP ' + r.status }; }).then(function(d) {
                    rawRows = []; rsGameIds = {};
                    dot.className = 'sdot error';
                    stxt.textContent = (d && d.error ? d.error.slice(0, 80) : 'HTTP ' + r.status);
                    resetRefreshBtn();
                    return Promise.reject('http' + r.status);
                });
            }
            return r.json();
        })
        .then(function(d) {
            // Handle both plain array and {games, alternateOdds} format
            var games = Array.isArray(d) ? d : (d && Array.isArray(d.games) ? d.games : null);
            altOdds = {};
            if (games) {
                rawRows = parseGames(games);
                rawRowsBySport[currentSport] = rawRows; // cache for Best EV tab
                var now = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
                if (rawRows.length) {
                    dot.className = 'sdot live';
                    stxt.textContent = 'Updated ' + now + ' - ' + (rawRows.length / 2 | 0) + ' games - FanDuel';
                } else {
                    dot.className = 'sdot error';
                    stxt.textContent = 'No ' + lbl + ' games right now';
                }
            } else {
                rawRows = []; rsGameIds = {};
                dot.className = 'sdot error';
                stxt.textContent = d && d.error ? 'Error: ' + d.error.slice(0, 80) : 'API error';
            }
        })
        .catch(function(e) {
            if (e === 'unauth' || e === 'rate' || e === 'banned') return;
            rawRows = []; rsGameIds = {};
            dot.className = 'sdot error';
            stxt.textContent = 'Error: ' + e.message;
        })
        .then(function() {
            resetRefreshBtn();
            renderTable();
            if (rawRows.length > 0) fetchRealMarkets(currentSport).then(function() { fetchAltLinesForNBA(); fetchExactEvForRows(currentSport); });
            if (currentSport === 'baseball_mlb') fetchKalshiRFI();
        });
    }

    // Fill preds from a Real Sports sync response for a set of rows — no global mutations
    function fillPredsFromSync(rows, syncData) {
        if (!syncData || !syncData.markets) return;
        var markets = syncData.markets;
        var marketKeys = Object.keys(markets);

        // Build resolved map identical to fetchRealMarkets: full-name game key → original Real key
        var resolvedMap = {};
        marketKeys.forEach(function(k) {
            if (k.endsWith('__lines') || k.endsWith('__gid')) return;
            // Strip " (2)" before resolving team names so the suffix doesn't corrupt abbreviation lookup
            var dhSuffix = k.endsWith(' (2)') ? ' (2)' : '';
            var kBase = dhSuffix ? k.slice(0, -4) : k;
            var parts = kBase.split(' @ ');
            if (parts.length !== 2) return;
            var resolvedKey = resolveTeamName(parts[0].trim()) + ' @ ' + resolveTeamName(parts[1].trim()) + dhSuffix;
            resolvedMap[resolvedKey] = k;
            resolvedMap[k] = k;
        });

        rows.forEach(function(r) {
            var mktLabel = r.mkt === 'ML' ? 'Game Winner' : r.mkt === 'Spread' ? 'Spread' : r.mkt === 'Total' ? 'Total' : r.mkt === 'RFI' ? 'Run in 1st inning?' : null;
            if (!mktLabel) return;

            // Try exact/resolved match first, then fuzzy fallback
            var realKey = resolvedMap[r.game];
            // Doubleheader: try (2) and base key first; fall through to fuzzy (RS uses short nicknames)
            if (!realKey) {
                var _dhm2 = r.game.match(/\(Game (\d+)\)/);
                if (_dhm2) {
                    var _dhBase2 = r.game.replace(/\s*\(Game \d+\)/, "").trim();
                    var _dhNum2 = parseInt(_dhm2[1]);
                    if (_dhNum2 >= 2) {
                        if (resolvedMap[_dhBase2 + ' (2)']) realKey = resolvedMap[_dhBase2 + ' (2)'];
                        // No fallback to base key for Game 2 — let fuzzy handle it with DH-awareness
                    } else {
                        if (resolvedMap[_dhBase2]) realKey = resolvedMap[_dhBase2];
                    }
                }
            }
            if (!realKey) {
                // Strip (Game N) so it doesn't pollute team name matching
                var _fuzzyGame2 = r.game.replace(/\s*\(Game \d+\)/, '').trim();
                var fdTeams = _fuzzyGame2.split(' @ ');
                // Normalize accents so "Atlético" matches "Atletico Madrid"
                function normSync(s) { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
                var fdAway = normSync(fdTeams[0] || '');
                var fdHome = normSync(fdTeams[1] || '');
                function nickname(s) { var w = s.trim().split(' '); return w[w.length - 1]; }
                var fdAwayNick = nickname(fdAway);
                var fdHomeNick = nickname(fdHome);
                var found = marketKeys.find(function(k) {
                    if (k.endsWith('__lines') || k.endsWith('__gid')) return false;
                    var parts = k.split(' @ ');
                    if (parts.length !== 2) return false;
                    var ra = normSync(resolveTeamName(parts[0].trim()));
                    var rh = normSync(resolveTeamName(parts[1].trim()));
                    // Also keep raw (pre-resolved) names as fallback — guards against cross-sport
                    // nickname collisions (e.g. "Spurs" resolves to San Antonio in NBA context
                    // but should match Tottenham Hotspur for soccer when currentSport isn't set to FC)
                    var raRaw = normSync(parts[0].trim());
                    var rhRaw = normSync(parts[1].trim());
                    var raNick = nickname(ra);
                    var rhNick = nickname(rh);
                    // Nickname match first, then any-word match (for soccer short names like "Atletico" vs "Atletico Madrid")
                    // Exclude geographic direction words — "south" in "South Korea" must not match "South Africa"
                    var _geoStop = { south: 1, north: 1, east: 1, west: 1, central: 1, new: 1 };
                    function notGeo(w) { return !_geoStop[w]; }
                    var _wcNameAliases = { 'usa': 'united states', 'united states': 'usa', "cote d'ivoire": 'ivory coast', 'ivory coast': "cote d'ivoire" };
                    function matchSide(r1, r1Nick, r1Raw, fd, fdNick) {
                        if (r1Nick === fdNick || r1.indexOf(fdNick) !== -1 || fd.indexOf(r1Nick) !== -1
                            || r1.split(' ').some(function(w) { return w.length > 2 && notGeo(w) && fd.indexOf(w) !== -1; })
                            || fd.split(' ').some(function(w) { return w.length > 2 && notGeo(w) && r1.indexOf(w) !== -1; })
                            || r1Raw.indexOf(fdNick) !== -1 || fd.indexOf(nickname(r1Raw)) !== -1
                            || r1Raw.split(' ').some(function(w) { return w.length > 2 && notGeo(w) && fd.indexOf(w) !== -1; })
                            || fd.split(' ').some(function(w) { return w.length > 2 && notGeo(w) && r1Raw.indexOf(w) !== -1; })) return true;
                        var r1Exp = _wcNameAliases[r1] || ''; var fdExp = _wcNameAliases[fd] || '';
                        return (!!r1Exp && (fd === r1Exp || fd.indexOf(r1Exp) !== -1 || r1Exp.indexOf(fd) !== -1))
                            || (!!fdExp && (r1 === fdExp || r1.indexOf(fdExp) !== -1 || fdExp.indexOf(r1) !== -1));
                    }
                    return matchSide(ra, raNick, raRaw, fdAway, fdAwayNick) && matchSide(rh, rhNick, rhRaw, fdHome, fdHomeNick);
                });
                if (found) {
                    // DH-awareness: Game 2 FD rows must use the RS ' (2)' key, not Game 1's key
                    var _isFdDH2 = /\(Game [2-9]/.test(r.game);
                    if (_isFdDH2 && !found.endsWith(' (2)')) {
                        if (marketKeys.indexOf(found + ' (2)') !== -1) found = found + ' (2)';
                        else found = null; // RS doesn't have Game 2 yet — don't show Game 1's RS%
                    } else if (!_isFdDH2 && found.endsWith(' (2)')) {
                        var _foundBase = found.replace(/ \(2\)$/, '');
                        if (marketKeys.indexOf(_foundBase) !== -1) found = _foundBase;
                    }
                    if (found) realKey = found;
                }
            }
            if (!realKey) return;

            // Populate rsGameIds so Real Sports links work in Best EV
            var gid = markets[realKey + '__gid'];
            if (gid) rsGameIds[r.game] = gid;
            var startMs = markets[realKey + '__startMs'];
            if (startMs) rsGameStartMs[r.game] = startMs;

            // Populate yourLines from Real Sports line data (spread/total)
            var gameLines = markets[realKey + '__lines'];
            if (gameLines) {
                if (r.mkt === 'Spread') {
                    var gParts = r.game.split(' @ ');
                    var isHome = gParts[1] && r.side.toLowerCase().indexOf(gParts[1].split(' ').pop().toLowerCase()) !== -1;
                    var spreadVal = isHome ? gameLines.homeSpread : gameLines.awaySpread;
                    if (spreadVal != null) yourLines[r.id] = spreadVal;
                }
                if (r.mkt === 'Total' && gameLines.total != null) {
                    yourLines[r.id] = gameLines.total;
                }
            }

            // markets[realKey] is the game object: { "Game Winner": {...}, "Spread": {...}, ... }
            var gameMarkets = markets[realKey];
            if (!gameMarkets) return;
            var mktData = gameMarkets[mktLabel];
            // MMA: RS may use a different label for fight winner market
            if (!mktData && (r._sport_key === 'mma_mixed_martial_arts' || currentSport === 'mma_mixed_martial_arts') && r.mkt === 'ML') {
                mktData = gameMarkets['Fight Outcome'] || gameMarkets['Fight Winner']
                       || gameMarkets['Match Winner'] || gameMarkets['Winner']
                       || Object.values(gameMarkets)[0];
            }
            // WC KO: RS may label "To Advance" market various ways
            if (!mktData && (r._sport_key === 'soccer_wc' || currentSport === 'soccer_wc') && r.mkt === 'ML') {
                mktData = gameMarkets['To Advance'] || gameMarkets['To Qualify'] || gameMarkets['To Progress']
                       || gameMarkets['Match Result'] || gameMarkets['1X2']
                       || gameMarkets['Home/Draw/Away'] || gameMarkets['Game Winner'];
            }
            var outcomes = mktData ? (mktData.outcomes || mktData) : null;
            if (!outcomes || !outcomes.length) return;

            var sideLower = r.side.toLowerCase();
            var match = null;
            if (r.mkt === 'Total') {
                var isOver = sideLower === 'over';
                match = outcomes.find(function(o) {
                    if (!o.label) return false;
                    return isOver ? o.label[0] === 'O' : o.label[0] === 'U';
                });
                if (!match) match = isOver ? outcomes[0] : outcomes[1];
            } else if (r.mkt === 'Spread' && (r._sport_key === 'soccer_fc' || currentSport === 'soccer_fc' || r._sport_key === 'soccer_wc' || currentSport === 'soccer_wc')) {
                // FC: find -0.5 and +0.5 outcomes — also check o.line since RS team-key substitution
                // can strip the ±0.5 suffix from the label, but line is extracted from the raw label.
                var fcMinusO2 = outcomes.find(function(o) { return o.line === -0.5 || (o.label && o.label.indexOf('-0.5') !== -1); });
                var fcPlusO2  = outcomes.find(function(o) { return o.line === 0.5  || (o.label && o.label.indexOf('+0.5') !== -1); });
                if (fcMinusO2 || fcPlusO2) {
                    var fcTw2 = r.side.toLowerCase().split(' ').filter(function(w) { return w.length > 2; });
                    function fcLbl2(o) {
                        if (!o || !o.label) return false;
                        var lbl = o.label.toLowerCase().replace(/[+-]?\d+\.?\d*\s*$/, '').trim();
                        return fcTw2.some(function(w) { return lbl.indexOf(w) !== -1 || w.indexOf(lbl) !== -1; });
                    }
                    if (fcLbl2(fcMinusO2)) {
                        match = fcMinusO2;
                    } else if (fcLbl2(fcPlusO2)) {
                        match = fcPlusO2;
                    } else if (fcMinusO2 && fcPlusO2) {
                        var _hm2 = r._dkSpreads && r._dkSpreads.Home && r._dkSpreads.Home['-0.5'];
                        var _am2 = r._dkSpreads && r._dkSpreads.Away && r._dkSpreads.Away['-0.5'];
                        var hFav2 = _hm2 != null && _am2 != null ? _hm2 <= _am2 : _hm2 != null;
                        match = (r.ps === 'B' === hFav2) ? fcMinusO2 : fcPlusO2;
                    } else {
                        match = fcMinusO2 || fcPlusO2;
                    }
                } else {
                    match = r.ps === 'A' ? outcomes[0] : outcomes[1];
                }
            } else {
                match = outcomes.find(function(o) {
                    if (!o.label) return false;
                    var ol = resolveTeamName(o.label).toLowerCase();
                    return sideLower.split(' ').some(function(w){ return w.length > 2 && ol.indexOf(w) !== -1; });
                });
            }
            if (match && match.pct != null) {
                var pct = parseFloat(match.pct);
                // If game has already started and RS probability is extreme (≤3% or ≥97%),
                // it's a post-game settled value — don't auto-populate, user can enter manually
                var gameStarted = r.cm && r.cm.getTime() < Date.now();
                if (gameStarted && (pct <= 3 || pct >= 97)) return;
                if (match.probability != null) probsExact[r.id] = match.probability;
                // FC: use RS label sign to assign the correct DK price and store aligned pct
                if (r.mkt === 'Spread' && (r._sport_key === 'soccer_fc' || currentSport === 'soccer_fc' || r._sport_key === 'soccer_wc' || currentSport === 'soccer_wc') && r._dkSpreads) {
                    var fcOutType2 = r.ps === 'B' ? 'Home' : 'Away';
                    var rsLine2 = match.line;
                    var dkSpr2 = (r._dkSpreads && r._dkSpreads[fcOutType2]) || {};
                    var dkPrice3 = rsLine2 != null ? dkSpr2[String(rsLine2)] : null;
                    if (dkPrice3 != null) { r.am = dkPrice3; r.pt = rsLine2; }
                    if (rsLine2 != null) yourLines[r.id] = rsLine2;
                    preds[r.id] = String(match.pct);
                } else {
                    preds[r.id] = String(match.pct);
                }
                if (mktData && mktData.volumeDisplay) vols[r.id] = mktData.volumeDisplay;
            }
        });
    }

    // Silently pre-fetch odds + Real Sports preds for all sports in the background after login
    // Never touches rawRows, currentSport, or renderTable
    async function preloadAllSports() {
        if (!isPro()) return;
        var noSpread = ['mma_mixed_martial_arts', 'baseball_mlb'];
        var sportsToLoad = SPORTS.filter(function(s) { return !s.noFetch && s.key !== currentSport; });
        var evBtn = document.getElementById('ev-tab-btn');
        var barWrap = document.getElementById('ev-loading-bar-wrap');
        var bar = document.getElementById('ev-loading-bar');
        var total = sportsToLoad.length + 1; // +1 for current sport already loaded
        var done = 1; // current sport counts as done
        function setBar(pct) {
            if (bar) bar.style.width = Math.round(pct) + '%';
            if (barWrap) barWrap.style.display = pct >= 100 ? 'none' : 'block';
        }
        if (barWrap) barWrap.style.display = 'block';
        setBar(Math.round(done / total * 100));

        // Fetch all sports in parallel — parseGames is sync so save/restore currentSport is atomic
        await Promise.all(sportsToLoad.map(async function(s) {
            if (rawRowsBySport[s.key] && rawRowsBySport[s.key].length) {
                done++;
                setBar(Math.round(done / total * 100));
                return;
            }
            try {
                // WC KO: DK "To Advance" (subcat 5826) — 2-way ML, includes ET + pens
                if (s.key === 'soccer_wc') {
                    var [wcResP, wcSyncResP] = await Promise.all([
                        fetch('/api/fd/wc', { credentials: 'same-origin' }),
                        fetch('/api/real/sync?sport=soccer_wc', { credentials: 'same-origin' })
                    ]);
                    var wcDataP = wcResP.ok ? await wcResP.json() : null;
                    if (wcDataP && wcDataP.ok && wcDataP.games) {
                        var wcRowsP = [];
                        Object.entries(wcDataP.games).forEach(function([gameKey, game]) {
                            var away = game.away, home = game.home;
                            var cm = game.cm ? new Date(game.cm) : null;
                            var gid = String(game.id);
                            var pid = gid + '-ta';
                            [[away, 'A', game.away_ml], [home, 'B', game.home_ml]].forEach(function(triple) {
                                var teamName = triple[0], ps = triple[1], am = triple[2];
                                if (am == null) return;
                                wcRowsP.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName,
                                    am: am, pt: null, pid: pid, ps: ps, gid: gid, league: game.league || '',
                                    _sport_key: 'soccer_wc' });
                            });
                        });
                        rawRowsBySport[s.key] = wcRowsP;
                        if (wcSyncResP.ok) {
                            var wcSyncDataP = await wcSyncResP.json();
                            fillPredsFromSync(wcRowsP, wcSyncDataP);
                            lastSyncData[s.key] = wcSyncDataP;
                        }
                    }
                    done++;
                    setBar(Math.round(done / total * 100));
                    return;
                }
                // FC: use FD native DK AH endpoint — not Odds API
                if (s.key === 'soccer_fc') {
                    var [fcRes, fcSyncResp] = await Promise.all([
                        fetch('/api/fd/fc', { credentials: 'same-origin' }),
                        fetch('/api/real/sync?sport=soccer_fc', { credentials: 'same-origin' })
                    ]);
                    var fcData = fcRes.ok ? await fcRes.json() : null;
                    if (fcData && fcData.ok && fcData.games) {
                        var fcRows = [];
                        Object.entries(fcData.games).forEach(function([gameKey, game]) {
                            var away = game.away, home = game.home;
                            var cm = game.cm ? new Date(game.cm) : null;
                            var gid = String(game.id);
                            var pid = gid + '-h2h';
                            var awayGetsMinus;
                            if (game.awm != null && game.hm != null) { awayGetsMinus = game.awm <= game.hm; }
                            else if (game.awm != null) { awayGetsMinus = true; }
                            else { awayGetsMinus = false; }
                            [[away, 'A'], [home, 'B']].forEach(function(pair) {
                                var teamName = pair[0], ps = pair[1];
                                var isAway = ps === 'A';
                                var isMinus = isAway ? awayGetsMinus : !awayGetsMinus;
                                var initAm = isMinus ? (isAway ? game.awm : game.hm) : (isAway ? game.awp : game.hp);
                                var initPt = isMinus ? -0.5 : 0.5;
                                if (initAm == null) return;
                                fcRows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'Spread', side: teamName,
                                    am: initAm, pt: initPt, pid: pid, ps: ps, gid: gid, league: game.league || '',
                                    _sport_key: 'soccer_fc', _dkSpreads: game.spreads || { Home: {}, Away: {} } });
                            });
                        });
                        rawRowsBySport[s.key] = fcRows;
                        if (fcSyncResp.ok) {
                            var fcSyncData = await fcSyncResp.json();
                            fillPredsFromSync(fcRows, fcSyncData);
                            lastSyncData[s.key] = fcSyncData;
                        }
                    }
                    done++;
                    setBar(Math.round(done / total * 100));
                    return;
                }
                // NBA: use FD native — no Odds API credits
                if (s.key === 'basketball_nba') {
                    var [nbaResP, nbaSyncResP] = await Promise.all([
                        fetch('/api/fd/nbaalts', { credentials: 'same-origin' }),
                        fetch('/api/real/sync?sport=basketball_nba', { credentials: 'same-origin' })
                    ]);
                    var nbaDataP = nbaResP.ok ? await nbaResP.json() : null;
                    if (nbaDataP && nbaDataP.ok && nbaDataP.games) {
                        var nbaRowsP = [];
                        Object.entries(nbaDataP.games).forEach(function([gameKey, game]) {
                            var away = game.away, home = game.home;
                            var cm = game.cm ? new Date(game.cm) : null;
                            var gid = String(game.id);
                            if (game.spreads) {
                                var pid = gid + '-spreads';
                                [[away,'A'],[home,'B']].forEach(function(pair) {
                                    var teamName = pair[0], ps = pair[1];
                                    var sideData = game.spreads[teamName];
                                    if (!sideData) return;
                                    var entry = Object.entries(sideData)[0];
                                    if (!entry) return;
                                    nbaRowsP.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'Spread', side: teamName, am: entry[1], pt: parseFloat(entry[0]), pid: pid, ps: ps, gid: gid, _sport_key: 'basketball_nba' });
                                });
                            }
                            if (game.totals) {
                                var pid = gid + '-totals';
                                [['Over','A'],['Under','B']].forEach(function(pair) {
                                    var side = pair[0], ps = pair[1];
                                    var sideData = game.totals[side];
                                    if (!sideData) return;
                                    var entry = Object.entries(sideData)[0];
                                    if (!entry) return;
                                    nbaRowsP.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'Total', side: side, am: entry[1], pt: parseFloat(entry[0]), pid: pid, ps: ps, gid: gid, _sport_key: 'basketball_nba' });
                                });
                            }
                            if (game.ml) {
                                var pid = gid + '-h2h';
                                [[away,'A'],[home,'B']].forEach(function(pair) {
                                    var teamName = pair[0], ps = pair[1];
                                    var price = game.ml[teamName];
                                    if (price == null) return;
                                    nbaRowsP.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid, _sport_key: 'basketball_nba' });
                                });
                            }
                        });
                        rawRowsBySport[s.key] = nbaRowsP;
                        if (nbaSyncResP.ok) {
                            var nbaSyncDataP = await nbaSyncResP.json();
                            fillPredsFromSync(nbaRowsP, nbaSyncDataP);
                            lastSyncData[s.key] = nbaSyncDataP;
                        }
                    }
                    done++;
                    setBar(Math.round(done / total * 100));
                    return;
                }
                // WNBA: use FD native — no Odds API credits
                if (s.key === 'basketball_wnba') {
                    var [wnbaResP, wnbaSyncResP] = await Promise.all([
                        fetch('/api/fd/wnbaalts', { credentials: 'same-origin' }),
                        fetch('/api/real/sync?sport=basketball_wnba', { credentials: 'same-origin' })
                    ]);
                    var wnbaDataP = wnbaResP.ok ? await wnbaResP.json() : null;
                    if (wnbaDataP && wnbaDataP.ok && wnbaDataP.games) {
                        var wnbaRowsP = [];
                        Object.entries(wnbaDataP.games).forEach(function([gameKey, game]) {
                            var away = game.away, home = game.home;
                            var cm = game.cm ? new Date(game.cm) : null;
                            var gid = String(game.id);
                            if (game.ml) {
                                var pid = gid + '-h2h';
                                [[away,'A'],[home,'B']].forEach(function(pair) {
                                    var teamName = pair[0], ps = pair[1];
                                    var price = game.ml[teamName];
                                    if (price == null) return;
                                    wnbaRowsP.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid, _sport_key: 'basketball_wnba' });
                                });
                            }
                        });
                        rawRowsBySport[s.key] = wnbaRowsP;
                        if (wnbaSyncResP.ok) {
                            var wnbaSyncDataP = await wnbaSyncResP.json();
                            fillPredsFromSync(wnbaRowsP, wnbaSyncDataP);
                            lastSyncData[s.key] = wnbaSyncDataP;
                        }
                    }
                    done++;
                    setBar(Math.round(done / total * 100));
                    return;
                }
                // NHL: use FD native — no Odds API credits
                if (s.key === 'icehockey_nhl') {
                    var [nhlResP, nhlSyncResP] = await Promise.all([
                        fetch('/api/fd/nhl', { credentials: 'same-origin' }),
                        fetch('/api/real/sync?sport=icehockey_nhl', { credentials: 'same-origin' })
                    ]);
                    var nhlDataP = nhlResP.ok ? await nhlResP.json() : null;
                    if (nhlDataP && nhlDataP.ok && nhlDataP.games) {
                        var nhlRowsP = [];
                        Object.entries(nhlDataP.games).forEach(function([gameKey, game]) {
                            var away = game.away, home = game.home;
                            var cm = game.cm ? new Date(game.cm) : null;
                            var gid = String(game.id);
                            if (game.spreads) {
                                var pid = gid + '-spreads';
                                [[away,'A'],[home,'B']].forEach(function(pair) {
                                    var teamName = pair[0], ps = pair[1];
                                    var sideData = game.spreads[teamName];
                                    if (!sideData) return;
                                    var entry = Object.entries(sideData)[0];
                                    if (!entry) return;
                                    nhlRowsP.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'Spread', side: teamName, am: entry[1], pt: parseFloat(entry[0]), pid: pid, ps: ps, gid: gid, _sport_key: 'icehockey_nhl' });
                                });
                            }
                            if (game.totals) {
                                var pid = gid + '-totals';
                                [['Over','A'],['Under','B']].forEach(function(pair) {
                                    var side = pair[0], ps = pair[1];
                                    var sideData = game.totals[side];
                                    if (!sideData) return;
                                    var entry = Object.entries(sideData)[0];
                                    if (!entry) return;
                                    nhlRowsP.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'Total', side: side, am: entry[1], pt: parseFloat(entry[0]), pid: pid, ps: ps, gid: gid, _sport_key: 'icehockey_nhl' });
                                });
                            }
                            if (game.ml) {
                                var pid = gid + '-h2h';
                                [[away,'A'],[home,'B']].forEach(function(pair) {
                                    var teamName = pair[0], ps = pair[1];
                                    var price = game.ml[teamName];
                                    if (price == null) return;
                                    nhlRowsP.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid, _sport_key: 'icehockey_nhl' });
                                });
                            }
                        });
                        rawRowsBySport[s.key] = nhlRowsP;
                        if (nhlSyncResP.ok) {
                            var nhlSyncDataP = await nhlSyncResP.json();
                            fillPredsFromSync(nhlRowsP, nhlSyncDataP);
                            lastSyncData[s.key] = nhlSyncDataP;
                        }
                    }
                    done++;
                    setBar(Math.round(done / total * 100));
                    return;
                }
                // MLB: use FD native — no Odds API credits
                if (s.key === 'baseball_mlb') {
                    var [mlbResP, rfiResP, mlbSyncResP] = await Promise.all([
                        fetch('/api/fd/mlb', { credentials: 'same-origin' }),
                        fetch('/api/fd/rfi', { credentials: 'same-origin' }),
                        fetch('/api/real/sync?sport=baseball_mlb', { credentials: 'same-origin' })
                    ]);
                    var mlbDataP = mlbResP.ok ? await mlbResP.json() : null;
                    var rfiDataP = rfiResP.ok ? await rfiResP.json() : null;
                    if (mlbDataP && mlbDataP.ok && mlbDataP.games) {
                        var mlbRowsP = [];
                        Object.entries(mlbDataP.games).forEach(function([gameKey, game]) {
                            var away = game.away, home = game.home;
                            var cm = game.cm ? new Date(game.cm) : null;
                            var gid = String(game.id);
                            var pid = gid + '-h2h';
                            [[away,'A'],[home,'B']].forEach(function(pair) {
                                var teamName = pair[0], ps = pair[1];
                                var price = game.ml[teamName];
                                if (price == null) return;
                                mlbRowsP.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid, _sport_key: 'baseball_mlb' });
                            });
                            if (rfiDataP && rfiDataP.ok && rfiDataP.rfi) {
                                var rfi = rfiDataP.rfi[gameKey];
                                if (!rfi) {
                                    var fdT = gameKey.split(' @ ');
                                    var fdA = (fdT[0]||'').toLowerCase(), fdH = (fdT[1]||'').toLowerCase();
                                    var mk = Object.keys(rfiDataP.rfi).find(function(k) {
                                        var p = k.split(' @ '); if (p.length !== 2) return false;
                                        var ka = p[0].toLowerCase(), kh = p[1].toLowerCase();
                                        return ka.split(' ').some(function(w){ return w.length>2&&fdA.indexOf(w)!==-1; })
                                            && kh.split(' ').some(function(w){ return w.length>2&&fdH.indexOf(w)!==-1; });
                                    });
                                    if (mk) rfi = rfiDataP.rfi[mk];
                                }
                                if (rfi) {
                                    var td = new Date(); var ds = td.getFullYear()+''+(td.getMonth()+1)+''+td.getDate();
                                    var rp = 'rfi-'+gameKey.replace(/[^a-z0-9]/gi,'')+'-'+ds;
                                    mlbRowsP.push({ id: rp+'-A', game: gameKey, cm: cm, mkt: 'RFI', side: 'Yes (YRFI)', am: rfi.yesAm, pt: null, pid: rp, ps: 'A', gid: gid, rfiFair: rfi.yesFair, _sport_key: 'baseball_mlb' });
                                    mlbRowsP.push({ id: rp+'-B', game: gameKey, cm: cm, mkt: 'RFI', side: 'No (NRFI)',  am: rfi.noAm,  pt: null, pid: rp, ps: 'B', gid: gid, rfiFair: rfi.noFair,  _sport_key: 'baseball_mlb' });
                                }
                            }
                        });
                        rawRowsBySport[s.key] = mlbRowsP;
                        if (mlbSyncResP.ok) {
                            var mlbSyncDataP = await mlbSyncResP.json();
                            fillPredsFromSync(mlbRowsP, mlbSyncDataP);
                            lastSyncData[s.key] = mlbSyncDataP;
                        }
                    }
                    done++;
                    setBar(Math.round(done / total * 100));
                    return;
                }
                var mkts = noSpread.indexOf(s.key) !== -1 ? 'h2h' : 'h2h,spreads,totals';
                var pair = await Promise.all([
                    fetch('/api/odds?sport=' + s.key + '&markets=' + mkts + '&bookmakers=fanduel'),
                    fetch('/api/real/sync?sport=' + s.key, { credentials: 'same-origin' })
                ]);
                var oddsResp = pair[0], syncResp = pair[1];
                // Update admin Odds API remaining display whenever we get a count back
                var _rem = oddsResp.headers.get('x-requests-remaining');
                if (_rem) { var _remEl = document.getElementById('api-remaining'); if (_remEl) _remEl.textContent = _rem + ' requests left'; }
                if (!oddsResp.ok) { done++; setBar(Math.round(done / total * 100)); return; }
                var d = await oddsResp.json();
                var games = Array.isArray(d) ? d : (d && Array.isArray(d.games) ? d.games : null);
                if (!games || !games.length) { done++; setBar(Math.round(done / total * 100)); return; }
                var savedSport = currentSport;
                currentSport = s.key;
                var parsed = parseGames(games);
                currentSport = savedSport;
                if (!parsed.length) { done++; setBar(Math.round(done / total * 100)); return; }
                // Tag each row with its sport key so fillPredsFromSync can apply sport-specific logic
                // (e.g. MMA fight winner label, FC ±0.5 AH direction) even when currentSport differs.
                parsed.forEach(function(r) { r._sport_key = s.key; });
                rawRowsBySport[s.key] = parsed;
                if (syncResp.ok) {
                    var syncData = await syncResp.json();
                    fillPredsFromSync(parsed, syncData);
                    lastSyncData[s.key] = syncData; // cache for Best EV Phase 2 pred lookup
                    if (s.key === currentSport) renderTable();
                }
            } catch(e) {}
            done++;
            setBar(Math.round(done / total * 100));
        }));

        // Pre-compute EV for all sports so Best EV tab renders instantly on click
        // fillPredsFromSync already ran for each sport during the fetch above,
        // so preds/probsExact are populated — pass null for syncData to skip re-applying.
        SPORTS.filter(function(s) { return !s.noFetch; }).forEach(function(s) {
            var rows = rawRowsBySport[s.key];
            if (rows && rows.length) computeAndCacheEv(rows, s.key, null);
        });

        // All sports loaded — enable Best EV button
        if (evBtn) {
            evBtn.disabled = false;
            evBtn.style.opacity = '';
            evBtn.style.cursor = '';
            evBtn.title = '';
        }
        setBar(100); // hides bar
    }

    function toggleGame(gk) {
        collapsed[gk] = !collapsed[gk];
        var isC = collapsed[gk];
        document.querySelectorAll('tr[data-gk]').forEach(function(tr) {
            if (tr.getAttribute('data-gk') === gk && !tr.classList.contains('ghrow')) {
                tr.classList.toggle('collapsed-row', isC);
            }
        });
        document.querySelectorAll('.gh-arrow[data-gk="' + gk + '"]').forEach(function(el) {
            el.classList.toggle('up', !isC);
        });
    }

    var FC_LEAGUES = ['ALL', 'UCL', 'EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'MLS'];

    function buildWcSubNav() {
        var nav = document.getElementById('wc-sub-nav');
        if (!nav) return;
        nav.innerHTML = '';
        ['Games', 'Futures'].forEach(function(label) {
            var key = label.toLowerCase();
            var btn = document.createElement('button');
            btn.className = 'fc-league-tab' + (key === wcSubTab ? ' active' : '');
            btn.textContent = label;
            btn.setAttribute('data-wc-sub', key);
            btn.onclick = function() {
                wcSubTab = key;
                nav.querySelectorAll('[data-wc-sub]').forEach(function(b) {
                    b.classList.toggle('active', b.getAttribute('data-wc-sub') === key);
                });
                if (key === 'futures') {
                    showWcFuturesPanel(true);
                    loadWcFutures();
                } else {
                    showWcFuturesPanel(false);
                    loadOdds();
                }
            };
            nav.appendChild(btn);
        });
    }

    function showWcFuturesPanel(show) {
        var fp = document.getElementById('wc-futures-panel');
        var tw = document.querySelector('.table-wrap');
        var mc = document.getElementById('mobile-cards');
        var ctrl = document.querySelector('.controls');
        var sb = document.querySelector('.status-bar');
        if (fp) fp.style.display = show ? 'block' : 'none';
        if (tw) tw.style.display = show ? 'none' : '';
        if (mc) mc.style.display = show ? 'none' : '';
        if (ctrl) ctrl.style.display = show ? 'none' : '';
        if (sb)  sb.style.display  = show ? 'none' : '';
    }

    function loadWcFutures() {
        var statusEl = document.getElementById('wc-futures-status');
        var tbody    = document.getElementById('wc-futures-tbody');
        if (statusEl) statusEl.textContent = 'Loading futures...';
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">Loading...</td></tr>';

        fetch('/api/fd/wc-futures', { credentials: 'same-origin' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (!data.ok || !data.teams || !data.teams.length) {
                if (statusEl) statusEl.textContent = data.error || 'No futures data available';
                if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">' + escHtml(data.error || 'No futures available') + '</td></tr>';
                return;
            }
            wcFuturesCache = data;
            var wcUnitEl = document.getElementById('wc-unit-size');
            if (wcUnitEl && !wcUnitEl._restored) {
                wcUnitEl.value = parseFloat(localStorage.getItem('raxedge_unit_size') || '300') || 300;
                wcUnitEl._restored = true;
            }
            renderWcFutures(data.teams, data.hasRS);
            if (statusEl) {
                var t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                statusEl.textContent = 'Updated ' + t + ' · ' + data.teams.length + ' teams · ' + (data.hasRS ? 'RS + DK' : 'DK only');
            }
        })
        .catch(function(e) {
            if (statusEl) statusEl.textContent = 'Error loading futures';
            if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">Error loading futures</td></tr>';
        });
    }

    function onWcUnitChange(val) {
        var n = parseFloat(val) || 300;
        localStorage.setItem('raxedge_unit_size', n);
        if (wcFuturesCache) renderWcFutures(wcFuturesCache.teams, wcFuturesCache.hasRS);
    }

    function renderWcFutures(teams, hasRS) {
        var tbody = document.getElementById('wc-futures-tbody');
        if (!tbody) return;
        var wcUnitEl = document.getElementById('wc-unit-size');
        var unitSize = wcUnitEl ? (parseFloat(wcUnitEl.value) || 300) : (parseFloat(localStorage.getItem('raxedge_unit_size') || '300') || 300);

        // Group rows by team, preserve server sort order for section ordering
        var sections = [];
        var sectionMap = {};
        teams.forEach(function(t) {
            if (!sectionMap[t.team]) {
                sectionMap[t.team] = { team: t.team, am: t.am, marketId: t.marketId, rows: [] };
                sections.push(sectionMap[t.team]);
            }
            sectionMap[t.team].rows.push(t);
        });

        function renderSideRow(t, grad) {
            var rspNum  = t.rsp    != null ? t.rsp    : null;
            var dkfNum  = t.dkFair != null ? t.dkFair : null;
            var edgeNum = t.edge   != null ? t.edge   : null;
            var rspPct  = rspNum  != null ? (rspNum  * 100).toFixed(1) + '%' : '—';
            var dkfPct  = dkfNum  != null ? (dkfNum  * 100).toFixed(1) + '%' : '—';
            var edgeStr = edgeNum != null ? (edgeNum >= 0 ? '+' : '') + (edgeNum * 100).toFixed(1) + '%' : '—';
            var edgeColor = edgeNum == null ? '' : edgeNum > 0 ? 'color:var(--green)' : 'color:var(--red)';
            var ev = null;
            if (rspNum > 0 && dkfNum != null) {
                var rake = rsBaseTake(rspNum);
                ev = (dkfNum / rspNum * (1 - rake) - 1) * 100;
            }
            var evStr  = ev != null ? (ev >= 0 ? '+' : '') + ev.toFixed(1) + '%' : '—';
            var evColor = ev == null ? '' : ev > 0 ? 'color:var(--green)' : 'color:var(--red)';
            var u = (ev != null && rspNum != null) ? unitsEV(ev, rspNum) : 0;
            var uStr   = u > 0 ? u + 'u' : '—';
            var uColor = u > 0 ? 'color:var(--green)' : 'color:var(--muted)';
            var betAmt = u > 0 ? RAX_ICON + Math.round(u * unitSize) : '—';
            var isYes  = t.side === 'YES';
            var sideColor = isYes ? 'var(--green)' : '#e05c5c';
            var sideBadge = '<span style="font-family:var(--mono);font-size:10px;font-weight:800;color:' + sideColor + ';background:' + sideColor + '22;padding:2px 6px;border-radius:3px">' + escHtml(t.side || 'YES') + '</span>';
            return '<tr>' +
                '<td style="padding-left:16px;font-size:11px;color:var(--muted)">' + sideBadge + '</td>' +
                '<td class="r" style="font-family:var(--mono);font-weight:700">' + rspPct + '</td>' +
                '<td class="r" style="font-family:var(--mono);opacity:0.6;font-size:11px">' + dkfPct + '</td>' +
                '<td class="r" style="font-family:var(--mono);' + edgeColor + '">' + edgeStr + '</td>' +
                '<td class="r" style="font-family:var(--mono);font-weight:800;' + evColor + '">' + evStr + '</td>' +
                '<td class="r" style="font-family:var(--mono);font-weight:700;' + uColor + '">' + uStr + '</td>' +
                '<td class="r" style="font-family:var(--mono);' + uColor + '">' + betAmt + '</td>' +
            '</tr>';
        }

        function buildSideStats(t) {
            var rspNum  = t.rsp    != null ? t.rsp    : null;
            var dkfNum  = t.dkFair != null ? t.dkFair : null;
            var edgeNum = t.edge   != null ? t.edge   : null;
            var rspPct  = rspNum  != null ? (rspNum  * 100).toFixed(1) + '%' : '—';
            var dkfPct  = dkfNum  != null ? (dkfNum  * 100).toFixed(1) + '%' : '—';
            var edgeStr = edgeNum != null ? (edgeNum >= 0 ? '+' : '') + (edgeNum * 100).toFixed(1) + '%' : '—';
            var edgeColor = edgeNum == null ? '' : edgeNum > 0 ? 'color:var(--green)' : 'color:var(--red)';
            var ev = null;
            if (rspNum > 0 && dkfNum != null) {
                var rake = rsBaseTake(rspNum);
                ev = (dkfNum / rspNum * (1 - rake) - 1) * 100;
            }
            var evStr  = ev != null ? (ev >= 0 ? '+' : '') + ev.toFixed(1) + '%' : '—';
            var evColor = ev == null ? '' : ev > 0 ? 'color:var(--green)' : 'color:var(--red)';
            var u = (ev != null && rspNum != null) ? unitsEV(ev, rspNum) : 0;
            var uStr   = u > 0 ? u + 'u' : '—';
            var uColor = u > 0 ? 'color:var(--green)' : 'color:var(--muted)';
            var betAmt = u > 0 ? RAX_ICON + Math.round(u * unitSize) : '—';
            return { rspPct: rspPct, dkfPct: dkfPct, edgeStr: edgeStr, edgeColor: edgeColor, evStr: evStr, evColor: evColor, uStr: uStr, uColor: uColor, betAmt: betAmt };
        }

        var html = '';
        var mhtml = '';
        sections.forEach(function(sec, si) {
            // YES first within each section
            sec.rows.sort(function(a, b) {
                if (a.side === 'YES' && b.side !== 'YES') return -1;
                if (b.side === 'YES' && a.side !== 'YES') return 1;
                return 0;
            });
            var grad = null;
            var cc = WC_FLAG_CC[sec.team] || '';
            var flagHtml = cc
                ? '<img src="https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/flags/4x3/' + cc + '.svg" width="22" height="15" style="vertical-align:middle;margin-right:7px;border-radius:2px;object-fit:cover" onerror="this.style.display=\'none\'">'
                : '';
            var flagHtmlCard = cc
                ? '<img src="https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/flags/4x3/' + cc + '.svg" width="28" height="19" style="vertical-align:middle;border-radius:2px;object-fit:cover;flex-shrink:0" onerror="this.style.display=\'none\'">'
                : '';
            var rsLink = ' <a href="https://www.realapp.com/pXjdilF6Fbz" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--accent);font-size:10px;text-decoration:none" title="View on Real Sports">&#8599;</a>';
            var amStr = sec.am > 0 ? '+' + sec.am : '' + sec.am;
            var wfc = WC_FLAG_COLORS[sec.team];
            var hdrGrad = wfc
                ? 'background:linear-gradient(90deg,' + hexRgba(wfc.c1, 0.35) + ',' + hexRgba(wfc.c2, 0.15) + ',transparent)'
                : 'background:var(--bg)';

            // Desktop table: section header row
            html += '<tr style="border-top:2px solid var(--border);' + hdrGrad + '">' +
                '<td colspan="7" style="padding:10px 12px 6px">' +
                    flagHtml +
                    '<span style="font-size:14px;font-weight:800">' + escHtml(sec.team) + '</span>' +
                    rsLink +
                    '<span style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-left:10px">DK ' + escHtml(amStr) + '</span>' +
                '</td>' +
            '</tr>';
            sec.rows.forEach(function(r) { html += renderSideRow(r, grad); });

            // Mobile card
            mhtml += '<div class="wc-fut-card">';
            mhtml += '<div class="wc-fut-card-hdr" style="' + hdrGrad + '">' +
                flagHtmlCard +
                '<strong>' + escHtml(sec.team) + '</strong>' +
                '<span class="wfc-dk">DK ' + escHtml(amStr) + '</span>' +
                '<a href="https://www.realapp.com/pXjdilF6Fbz" target="_blank" rel="noopener" class="wfc-rslink" title="View on Real Sports">&#8599; RS</a>' +
            '</div>';
            sec.rows.forEach(function(r) {
                var s = buildSideStats(r);
                var isYes = r.side === 'YES';
                var sideColor = isYes ? 'var(--green)' : '#e05c5c';
                var sideBadge = '<span style="font-family:var(--mono);font-size:10px;font-weight:800;color:' + sideColor + ';background:' + sideColor + '22;padding:2px 6px;border-radius:3px;flex-shrink:0">' + escHtml(r.side || 'YES') + '</span>';
                mhtml += '<div class="wc-fut-side">';
                mhtml += '<div class="wc-fut-side-head">' + sideBadge;
                if (s.uStr !== '—') {
                    mhtml += '<span style="font-family:var(--mono);font-size:12px;font-weight:700;' + s.uColor + ';margin-left:auto">' + s.uStr + ' · ' + s.betAmt + '</span>';
                }
                mhtml += '</div>';
                mhtml += '<div class="wc-fut-stats-row">' +
                    '<span class="wfc-stat"><span class="wfc-stat-lbl">Real </span>' + s.rspPct + '</span>' +
                    '<span class="wfc-stat"><span class="wfc-stat-lbl">FD Fair </span>' + s.dkfPct + '</span>' +
                    '<span class="wfc-stat" style="' + s.edgeColor + '"><span class="wfc-stat-lbl">Edge </span>' + s.edgeStr + '</span>' +
                    '<span class="wfc-stat" style="' + s.evColor + '"><span class="wfc-stat-lbl">EV </span>' + s.evStr + '</span>' +
                '</div>';
                mhtml += '</div>';
            });
            mhtml += '</div>';
        });
        tbody.innerHTML = html;
        var mobileEl = document.getElementById('wc-futures-mobile');
        if (mobileEl) mobileEl.innerHTML = mhtml;
    }

    function buildFcLeagueNav() {
        var nav = document.getElementById('fc-league-nav');
        if (!nav) return;
        nav.innerHTML = '';
        FC_LEAGUES.forEach(function(league) {
            var btn = document.createElement('button');
            btn.className = 'fc-league-tab' + (league === currentFcLeague ? ' active' : '');
            btn.textContent = league;
            btn.onclick = function() {
                currentFcLeague = league;
                nav.querySelectorAll('.fc-league-tab').forEach(function(b) {
                    b.classList.toggle('active', b.textContent === league);
                });
                renderTable();
            };
            nav.appendChild(btn);
        });
    }

    function renderTable() {
        if (evTabVisible || otdVisible) return;
        var _panels = ['admin-panel','portfolio-panel','alerts-panel','referral-panel','ev-panel','otd-panel'];
        if (_panels.some(function(id){ return document.getElementById(id)?.classList.contains('visible'); })) return;
        var tableWrap = document.querySelector('.table-wrap');
        if (tableWrap) tableWrap.style.display = '';
        var unit = parseFloat(document.getElementById('unit-size').value) || 300;
        var q = document.getElementById('search').value.trim().toLowerCase();
        if (!rawRows.length) {
            document.getElementById('tbody').innerHTML = '<tr class="state-row"><td colspan="10">No odds - hit Refresh</td></tr>';
            var _sl = document.getElementById('stat-lines'); if (_sl) _sl.textContent = '0';
            var _se = document.getElementById('stat-edges'); if (_se) _se.textContent = '0';
            return;
        }
        var pairs = {};
        rawRows.forEach(function(r) {
            if (!pairs[r.pid]) pairs[r.pid] = {};
            pairs[r.pid][r.ps] = r;
        });
        var rows = rawRows.map(function(r) {
            var p = pairs[r.pid] || {};
            var nv = novig(p.A ? imp(p.A.am) : null, p.B ? imp(p.B.am) : null);
            var yl = yourLines[r.id] != null ? yourLines[r.id] : null;
            var altNV = getAltFair(r, yl, p.A, p.B);
            // RFI uses Kalshi devigged fair value; WC uses pre-computed 3-way novig fair
            var fair, af;
            if (r._wcFair != null) {
                fair = r._wcFair;
                af = r._wcFair;
            } else if (r.mkt === 'RFI' && r.rfiFair != null) {
                fair = r.rfiFair;
                af = r.rfiFair;
            } else {
                fair = altNV ? (r.ps === 'A' ? altNV.fa : altNV.fb) : (r.ps === 'A' ? nv.fa : nv.fb);
                af = altNV ? fair : adjFair(fair, r.pt, yl, r.mkt, r.ps);
            }
            var pr = preds[r.id];
            var pred = (pr !== undefined && pr !== '') ? Math.min(0.999, Math.max(0.001, (probsExact[r.id] != null ? probsExact[r.id] : parseFloat(pr) / 100) + rsPredAdj / 100)) : null;
            // All sports: users bet at RS, sharp book (FD/DK) is reference (af)
            // Value = sharp novig > RS probability = RS offering longer odds than sharp fair
            // edge = (af - pred), EV = (af/pred) * (1-rake) - 1
            var edge = (af != null && pred != null && isFinite(pred)) ? (af - pred) * 100 : null;
            var evForUnits = null;
            if (af != null && pred != null && pred > 0 && pred < 1) {
                evForUnits = (af * (1/pred) * (1-rsBaseTake(pred)) - 1) * 100;
                // >100% EV is a post-game artifact — treat as no edge
                // Exception: soccer FC live ±0.5 lines can legitimately produce >100% EV
                if (evForUnits > 100 && currentSport !== 'soccer_fc' && currentSport !== 'soccer_wc') evForUnits = null;
            }
            var u = (isPro() || r.mkt === 'ML' || r.mkt === 'RFI') ? unitsEV(evForUnits, pred) : units(edge);
            // When RS line differs from FD base line and DK alt data is available,
            // show DK's alt price (not FD's base price) since that's the actual line being bet.
            var dispAm = r.am, dispPt = r.pt;
            if (altNV && yl != null && r.gid && (r.mkt === 'Spread' || r.mkt === 'Total')) {
                var dkGame = dkAltOdds[r.gid];
                if (dkGame) {
                    var dkAltPrice;
                    if (r.mkt === 'Spread' && dkGame.spreads) {
                        dkAltPrice = dkClosestPrice(dkGame.spreads[r.ps === 'A' ? 'Away' : 'Home'], parseFloat(yl));
                    } else if (r.mkt === 'Total' && dkGame.totals) {
                        dkAltPrice = dkClosestPrice(dkGame.totals[r.ps === 'A' ? 'Over' : 'Under'], parseFloat(yl));
                    }
                    if (dkAltPrice != null) { dispAm = dkAltPrice; dispPt = parseFloat(yl); }
                }
            }
            return { id: r.id, game: r.game, cm: r.cm, mkt: r.mkt, side: r.side, am: dispAm, pt: dispPt, ps: r.ps, pid: r.pid, gid: r.gid, league: r.league, fair: fair, af: af, yl: yl, edge: edge, u: u, bet: u * unit };
        });
        cacheEvRows(rows, currentSport);
        var now = new Date();
        var filtered = rows.filter(function(r) {
            // MLB: backend already limits to -5h/+16h window; just hide games that have ended
            if (currentSport === 'baseball_mlb' && r.cm && (now - r.cm) > 5 * 60 * 60 * 1000) return false;
            // WC: rolling window — games that kicked off within the last 4h or start within next 24h.
            // Avoids local-midnight boundary issues for users in UTC/UTC+ timezones.
            if (currentSport === 'soccer_wc' && r.cm) {
                var wcPast   = new Date(now.getTime() - 4 * 60 * 60 * 1000);
                var wcFuture = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                if (r.cm < wcPast || r.cm > wcFuture) return false;
            }
            // RFI: hide once game has started — market resolves in 1st inning
            if (r.mkt === 'RFI' && r.cm && r.cm <= now) return false;
            if (r.mkt === 'Spread' || r.mkt === 'Total') {
                var isHockey = currentSport === 'icehockey_nhl';
                var isNBA = currentSport === 'basketball_nba';

                // All sports: hide spread if signs are opposite AND gap > 2 (sign flip = bad data)
                // Skip for live NBA — DK alt lines can legitimately cross 0 (e.g., big favourite becomes underdog)
                var isLiveNBA = isNBA && r.cm && r.cm <= now;
                if (r.mkt === 'Spread' && r.pt != null && yourLines[r.id] != null && !isLiveNBA) {
                    var fdPt = parseFloat(r.pt);
                    var rlPt = parseFloat(yourLines[r.id]);
                    var gap = Math.abs(rlPt - fdPt);
                    if (fdPt !== 0 && rlPt !== 0 && Math.sign(fdPt) !== Math.sign(rlPt) && gap > 2) return false;
                }

                // Live NBA: hide spread/total unless DK has the exact Real Sports line
                if (isLiveNBA && (r.mkt === 'Spread' || r.mkt === 'Total') && r.pt != null && yourLines[r.id] != null) {
                    if (Math.abs(parseFloat(r.pt) - parseFloat(yourLines[r.id])) > 0.001) return false;
                }

                // NBA/NHL: if FD line ≠ RS line, we need DK's odds for the RS line.
                // DK main spread is now included in dkAltOdds (merged alongside alt lines),
                // so dkClosestPrice will find it even when RS line = DK's main line.
                if ((isNBA || isHockey) && r.gid && (r.mkt === 'Spread' || r.mkt === 'Total') && yourLines[r.id] != null && r.pt != null) {
                    var _rsLine = parseFloat(yourLines[r.id]);
                    var _fdLine = parseFloat(r.pt);
                    if (Math.abs(_rsLine - _fdLine) > 0.001) {
                        var _dkGame = dkAltOdds[r.gid];
                        if (!_dkGame) return false;
                        var _dkSideKey = r.ps === 'A' ? (r.mkt === 'Spread' ? 'Away' : 'Over') : (r.mkt === 'Spread' ? 'Home' : 'Under');
                        var _dkLines = r.mkt === 'Spread' ? (_dkGame.spreads && _dkGame.spreads[_dkSideKey]) : (_dkGame.totals && _dkGame.totals[_dkSideKey]);
                        if (!_dkLines || dkClosestPrice(_dkLines, _rsLine) == null) return false;
                    }
                }

                // All other sports: hide if gap exceeds 4 points
                if (!isHockey && !isNBA && r.pt != null && yourLines[r.id] != null) {
                    var gap = Math.abs(parseFloat(yourLines[r.id]) - parseFloat(r.pt));
                    if (gap > 4) return false;
                }
            }
            if (!q) return true;
            return (r.game + ' ' + r.side + ' ' + r.mkt).toLowerCase().indexOf(q) !== -1;
        });
        // EV-only filter
        if (showEVOnly) {
            filtered = filtered.filter(function(r) {
                var pr = preds[r.id];
                if (!pr || r.af == null) return false;
                var pred = Math.min(0.999, Math.max(0.001, (probsExact[r.id] != null ? probsExact[r.id] : parseFloat(pr) / 100) + rsPredAdj / 100));
                if (pred <= 0 || pred >= 1) return false;
                var rake = rsBaseTake(pred);
                var ev = (r.af * (1/pred) * (1-rake) - 1) * 100;
                return ev >= 5;
            });
        }
        // FC league sub-nav filter
        if (currentSport === 'soccer_fc' && currentFcLeague !== 'ALL') {
            filtered = filtered.filter(function(r) { return r.league === currentFcLeague; });
        }
        var mO = { ML: 0, Spread: 1, Total: 2, RFI: 3 };
        var FC_LEAGUE_ORDER = { 'UCL': 0, 'EPL': 1, 'La Liga': 2, 'Serie A': 3, 'Bundesliga': 4, 'Ligue 1': 5, 'MLS': 6 };
        filtered.sort(function(a, b) {
            if (currentSport === 'soccer_fc' && a.league !== b.league) {
                var oa = FC_LEAGUE_ORDER[a.league] !== undefined ? FC_LEAGUE_ORDER[a.league] : 99;
                var ob = FC_LEAGUE_ORDER[b.league] !== undefined ? FC_LEAGUE_ORDER[b.league] : 99;
                if (oa !== ob) return oa - ob;
            }
            var ta = a.cm ? a.cm.getTime() : 9e12, tb = b.cm ? b.cm.getTime() : 9e12;
            if (ta !== tb) return ta - tb;
            if (a.game !== b.game) return a.game < b.game ? -1 : 1;
            if (a.mkt !== b.mkt) return (mO[a.mkt] || 0) - (mO[b.mkt] || 0);
            return 0;
        });
        var ec = filtered.filter(function(r) { return r.edge != null && r.edge > 0; }).length;
        var _sl = document.getElementById('stat-lines'); if (_sl) _sl.textContent = filtered.length;
        var _se = document.getElementById('stat-edges'); if (_se) _se.textContent = ec;
        if (!filtered.length) {
            document.getElementById('tbody').innerHTML = '<tr class="state-row"><td colspan="13">No results</td></tr>';
            return;
        }
        var gOrder = [], gSeen = {};
        filtered.forEach(function(r) {
            if (!gSeen[r.game]) { gSeen[r.game] = true; gOrder.push(r.game); }
        });
        var gColor = {}, gCm = {};
        gOrder.forEach(function(g, i) {
            var _gp = g.split(' @ ');
            var _ht = (_gp[_gp.length - 1] || g).trim();
            gColor[g] = teamColor(_ht);
            var row = filtered.find(function(r) { return r.game === g; });
            gCm[g] = row ? row.cm : null;
        });
        var html = '', lastG = null, lastLeague = null;
        filtered.forEach(function(r) {
            var color = gColor[r.game];
            var isC = !!collapsed[r.game];
            // FC: insert league sub-header when league changes (only in ALL view)
            if (currentSport === 'soccer_fc' && currentFcLeague === 'ALL' && r.league && r.league !== lastLeague) {
                lastLeague = r.league;
                html += '<tr style="background:var(--bg2);border-bottom:1px solid var(--border2)">'
                + '<td colspan="13" style="padding:6px 12px;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--accent)">'
                + escHtml(r.league) + '</td></tr>';
            }
            if (r.game !== lastG) {
                lastG = r.game;
                var ti = timeInfo(gCm[r.game]);
                var teams = r.game.split(' @ ');
                var _dhMatch = (teams[1] || '').match(/^(.*?)\s*(\(Game (\d+)\))\s*$/);
                var _homeTeam = _dhMatch ? _dhMatch[1].trim() : (teams[1] || '');
                var _gameNum  = _dhMatch ? _dhMatch[3] : null;
                var gk = r.game.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                html += '<tr class="ghrow" data-gk="' + r.game.replace(/"/g, '&quot;') + '" onclick="toggleGame(\'' + gk + '\')">'
                + '<td colspan="13"><div class="gh-inner">'
                + sportLogoHtml(currentSport, r.league, 20)
                + '<div style="display:grid;grid-template-columns:auto minmax(0,1fr) auto auto minmax(0,1fr);align-items:center;gap:4px;flex:1;min-width:0">' + teamLogoHtml(teams[0], 20) + teamNameHtml(teams[0]) + '<span style="color:var(--muted2);text-align:center;padding:0 2px">@</span>' + teamLogoHtml(_homeTeam, 20) + teamNameHtml(_homeTeam) + '</div>'
                + (_gameNum ? '<span class="gh-badge" style="flex-shrink:0;margin-left:6px;background:rgba(255,255,255,0.1);color:var(--muted2);font-size:10px;letter-spacing:.06em">GAME ' + _gameNum + '</span>' : '')
                + (ti.lbl ? '<span class="gh-badge ' + ti.cls + '" style="flex-shrink:0;margin-left:6px">' + ti.lbl + '</span>' : '')
                + '<span class="gh-score-badge gh-badge" data-game="' + r.game.replace(/"/g, '&quot;') + '" data-cm="' + (r.cm ? r.cm.getTime() : '') + '" style="display:none"></span>'
                + '<span class="live-score-badge gh-badge" style="display:none"></span>'
                + '<span class="gh-arrow' + (isC ? '' : ' up') + '" data-gk="' + r.game.replace(/"/g, '&quot;') + '">&#9660;</span>'
                + '</div></td></tr>';
            }
            html += buildRow(r, color, isC);
        });
        document.getElementById('tbody').innerHTML = html;
        renderMobileCards(filtered);
        updateScoreBadges();
    }

    function buildRow(r, color, isC) {
        // Free users: Spread and Total rows are locked — show blurred placeholder, click to upgrade
        if (!isPro() && r.mkt !== 'ML' && r.mkt !== 'RFI') {
            var gk = r.game.replace(/"/g, '&quot;');
            var lockedLine = r.mkt === 'Total' ? (r.ps === 'A' ? 'O ???' : 'U ???') : (r.ps === 'A' ? '+?.5' : '-?.5');
            var _lgp = r.game.split(' @ ');
            var _lrc = r.mkt === 'Total' ? teamColor(r.ps === 'A' ? (_lgp[0]||'').trim() : (_lgp[1]||'').trim()) : teamColor(r.side);
            return '<tr class="' + (isC ? 'collapsed-row' : '') + '" data-gk="' + gk + '" data-row-id="' + r.id + '" style="cursor:pointer;' + edgeBg(null) + '" onclick="showUpgradeModal(\'Spread and Total markets are available on the Pro plan. Upgrade to unlock spread and total betting across all sports.\')">'
            + '<td style="width:24px;padding:0 4px"></td>'
            + '<td class="game-td" data-label="Game" style="border-left:3px solid ' + _lrc + '"><div style="font-weight:600;filter:blur(4px);user-select:none;pointer-events:none">' + r.side + '</div><div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px">' + r.game + '</div></td>'
            + '<td data-label="Market"><span class="mkt-badge">' + fmtMkt(r.mkt) + '</span></td>'
            + '<td data-label="Side" style="filter:blur(4px);user-select:none;pointer-events:none;color:var(--muted);font-size:12px">' + r.side + '</td>'
            + '<td class="r adv-col" data-label="Consensus" style="filter:blur(4px);user-select:none;pointer-events:none"><span class="odds-neg">-115</span></td>'
            + '<td class="r adv-col" data-label="Adj. Fair %" style="filter:blur(4px);user-select:none;pointer-events:none;font-family:var(--mono);color:var(--muted)">50.0%</td>'
            + '<td class="c" data-label="Real %"></td>'
            + '<td class="r adv-col" data-label="Edge" style="filter:blur(4px);user-select:none;pointer-events:none"><span class="e-weak">+2.5%</span></td>'
            + '<td class="r" data-label="EV"><span style="filter:blur(4px);font-family:var(--mono);font-size:12px;font-weight:600;color:var(--green);user-select:none;pointer-events:none">+5.2%</span><span style="font-size:9px;font-weight:700;background:var(--accent);color:#fff;border-radius:3px;padding:1px 4px;margin-left:3px;vertical-align:middle">PRO</span></td>'
            + '<td class="r adv-col" data-label="Units"><span class="u-pass">—</span></td>'
            + '<td class="r" data-label="Bet"><span class="u-pass">—</span></td>'
            + '<td class="c"></td>'
            + '</tr>';
        }
        var am = fmtAm(r.am);
        var aCls = Number(r.am) >= 0 ? 'odds-pos' : 'odds-neg';
        var lineStr = '-';
        if (r.pt != null)
            lineStr = r.mkt === 'Total' ? (r.ps === 'A' ? 'O ' : 'U ') + Math.abs(r.pt) : (r.pt >= 0 ? '+' + r.pt : '' + r.pt);
        var fairStr = r.fair != null ? (r.fair * 100).toFixed(1) + '%' : '-';
        var afStr = r.af != null ? (r.af * 100).toFixed(1) + '%' : '-';
        var afChanged = (r.yl != null && r.pt != null && parseFloat(r.yl) !== parseFloat(r.pt));
        var es = '-', ec = 'e-none', bw = 0, bc = 'var(--muted2)';
        if (r.edge != null) {
            es = (r.edge > 0 ? '+' : '') + r.edge.toFixed(1) + '%';
            if (r.edge >= 8) { ec = 'e-strong'; bc = 'var(--green)'; }
            else if (r.edge >= 5) { ec = 'e-med'; bc = '#7ddfab'; }
            else if (r.edge > 0) { ec = 'e-weak'; bc = 'var(--yellow)'; }
            else { ec = 'e-neg'; bc = 'var(--red)'; }
            bw = Math.min(Math.abs(r.edge) * 5, 50);
        }
        var uH = r.u === 0 ? '<span class="u-pass">PASS</span>' : '<span class="u-val">' + r.u + 'u</span>';
        var bH = r.u === 0 ? '<span class="u-pass">-</span>' : '<span class="bet-val">' + RAX_ICON + r.bet.toFixed(0) + '</span>';
        var evH = '-';
        var predEV = preds[r.id];
        if (predEV && r.af != null) {
            var ev = null;
            var realPctEV = Math.min(0.999, Math.max(0.001, (probsExact[r.id] != null ? probsExact[r.id] : parseFloat(predEV) / 100) + rsPredAdj / 100));
            if (realPctEV > 0 && realPctEV < 1) {
                var rakeEV = rsBaseTake(realPctEV);
                ev = (r.af * (1/realPctEV) * (1-rakeEV) - 1) * 100;
            }
            if (ev != null) {
                // >100% EV = post-game artifact (RS knows result, FD market still open)
                // Exception: soccer FC live ±0.5 lines can legitimately produce >100% EV
                if (ev > 100 && currentSport !== 'soccer_fc' && currentSport !== 'soccer_wc') { evH = '-'; } else {
                var evColor = ev >= 5 ? 'var(--green)' : ev > 0 ? 'var(--yellow)' : 'var(--red)';
                evH = '<span style="font-family:var(--mono);font-size:12px;font-weight:600;color:' + evColor + '">' + (ev > 0 ? '+' : '') + ev.toFixed(1) + '%</span>';
                }
            }
        }
        var _rawPv = parseFloat(preds[r.id]);
        var pv = isFinite(_rawPv) ? (rsPredAdj ? String(Math.min(99, Math.max(1, Math.round(_rawPv + rsPredAdj)))) : preds[r.id]) : '';
        var ylv = (r.yl != null && r.yl !== '') ? r.yl : '';
        var ph = r.pt != null ? r.pt : '';
        var lc = afChanged ? ' line-changed' : '';
        var ylCell = r.mkt === 'ML' || r.mkt === 'RFI' || currentSport === 'soccer_wc'
            ? '<td class="c" data-label="Real Line"></td>'
            : '<td class="c" data-label="Real Line"><input class="cell-inp' + lc + '" type="number" step="0.5" placeholder="' + ph + '" value="' + ylv + '" data-id="' + r.id + '" onblur="setLine(this)" onkeydown="if(event.key===\'Enter\')this.blur()"></td>';
        // RFI: FD Line col shows Kalshi label, No-Vig shows Kalshi fair, Adj Fair same
        var isRFI = r.mkt === 'RFI';
        var fdLineCell = isRFI
            ? '<td data-label="FD Line" style="font-family:var(--mono);font-size:10px;color:var(--accent)">FD</td>'
            : '<td data-label="FD Line" style="font-family:var(--mono);color:var(--muted);font-size:12px">' + lineStr + '</td>';
        var evGated = isPro() || r.mkt === 'ML' || r.mkt === 'RFI';
        var gk = r.game.replace(/"/g, '&quot;');
        // Per-row team color: Total rows map Over→away, Under→home; others use r.side directly
        var _rgp = r.game.split(' @ ');
        var _rawayT = (_rgp[0] || '').trim(), _rhomeT = (_rgp[1] || '').trim();
        var _wcfc = (r.mkt !== 'Total' && r.mkt !== 'RFI') ? WC_FLAG_COLORS[r.side] : null;
        var _wcSideColor = _wcfc ? (r.ps === 'A' ? _wcfc.c2 : _wcfc.c1) : null;
        var rowColor = r.mkt === 'Total'
            ? teamColor(r.ps === 'A' ? _rawayT : _rhomeT)
            : r.mkt === 'RFI' ? 'transparent'
            : (_wcSideColor || teamColor(r.side));
        var _rgc2 = (r.mkt !== 'Total' && r.mkt !== 'RFI') ? TEAM_COLORS_2[r.side] : null;
        var _rgc1 = _rgc2 ? TEAM_COLORS[r.side] : null;
        var rowGrad = (r.mkt !== 'Total' && r.mkt !== 'RFI')
            ? (_wcSideColor ? hexRgba(_wcSideColor, 0.18)
               : (_rgc1 && _rgc2 ? hexRgba(_rgc1, 0.18) + ',' + hexRgba(_rgc2, 0.1)
               : teamColorAt(r.side, '2e')))
            : '';
        var rfiColor = r.mkt === 'RFI' ? (r.ps === 'A' ? '#3ddc84' : '#ff5f5f') : '';
        var autoFromRow = autoTakenFrom[r.id] || null;
        var takenBl = betTaken[r.id] ? (autoFromRow ? 'border-left:3px solid #f5a623;' : 'border-left:3px solid ' + rowColor + ';') : 'border-left:3px solid ' + rowColor + ';';
        var takenBg = autoFromRow ? 'background:rgba(245,166,35,0.06);' : '';
        var takenOp = betTaken[r.id] ? 'opacity:0.4;' : '';
        var autoRowTag = autoFromRow
            ? '<span style="display:inline-block;font-size:8px;font-weight:700;color:#f5a623;background:rgba(245,166,35,0.15);border:1px solid rgba(245,166,35,0.4);border-radius:3px;padding:1px 4px;margin-left:4px;letter-spacing:.03em;vertical-align:middle;white-space:nowrap">' + (autoFromRow === '__auto__' ? 'Other side taken' : 'Took ' + escHtml(autoFromRow)) + '</span>'
            : (betTaken[r.id] ? '<span style="display:inline-block;font-size:8px;font-weight:700;color:#4caf50;background:rgba(76,175,80,0.15);border:1px solid rgba(76,175,80,0.4);border-radius:3px;padding:1px 4px;margin-left:4px;letter-spacing:.03em;vertical-align:middle;white-space:nowrap">Taken</span>' : '');
        var _rsRowUrl = rsMarketIds[r.id]
            ? getRealSportsMarketUrl(rsMarketIds[r.id])
            : (rsGameIds[r.game] ? getRealSportsUrl(rsGameIds[r.game], currentSport, r.league, r.game) : null);
        return '<tr class="' + (r.edge != null && r.edge > 0 ? 'has-edge' : '') + (isC ? ' collapsed-row' : '') + '" data-gk="' + gk + '" data-row-id="' + r.id + '" style="' + takenBg + takenOp + edgeBg(r.edge) + '">'
        + '<td style="width:26px;padding:0 3px;text-align:center">' + (_rsRowUrl ? '<a href="' + escHtml(_rsRowUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="View on Real Sports" class="rs-icon-btn">' + RS_LOGO_SVG + '</a>' : '') + '</td>'
        + '<td class="game-td" data-label="Game" style="' + takenBl + '"><div style="font-weight:600;display:flex;align-items:center;gap:5px">' + (r.mkt !== 'Total' && r.mkt !== 'RFI' ? teamLogoHtml(r.side, 16) : '') + '<span' + (rowGrad ? ' style="padding:1px 8px 1px 4px;background:linear-gradient(90deg,' + rowGrad + ',transparent);border-radius:3px"' : '') + (rfiColor ? ' style="color:' + rfiColor + '"' : '') + '>' + r.side + '</span>' + autoRowTag + '</div><div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px">' + r.game + '</div></td>'
        + '<td data-label="Market"><span class="mkt-badge">' + fmtMkt(r.mkt) + '</span></td>'
        + '<td data-label="Side" style="color:var(--muted);font-size:12px"><span style="display:inline-flex;align-items:center;gap:4px;vertical-align:middle">' + (r.mkt !== 'Total' && r.mkt !== 'RFI' ? '<span class="adv-col">' + teamLogoHtml(r.side, 14) + '</span>' : '') + r.side + '</span></td>'
        + '<td class="r adv-col" data-label="Consensus"><span class="' + aCls + '">' + am + '</span></td>'
        + '<td class="r adv-col" data-label="Adj. Fair %" style="font-family:var(--mono);color:var(--muted)">' + afStr + '</td>'
        + '<td class="c" data-label="Real %"><div style="display:flex;flex-direction:column;align-items:center;gap:2px;justify-content:center"><div style="display:flex;align-items:center;gap:4px;justify-content:center"><input class="cell-inp' + (pv ? ' filled' : '') + '" type="number" min="1" max="99" step="1" inputmode="numeric" placeholder="-" value="' + pv + '" data-id="' + r.id + '" oninput="setPred(this)" onblur="setPred(this)" onkeydown="if(event.key===\'Enter\')this.blur()"><span class="pred-unit">%</span></div>' + (vols[r.id] ? '<span class="vol-span" style="font-size:9px;color:var(--muted2);font-family:var(--mono)">' + vols[r.id] + ' vol</span>' : '') + '</div></td>'
        + '<td class="r adv-col" data-label="Edge"><div class="edge-wrap"><div class="edge-bar-bg"><div class="edge-bar-fill" style="width:' + bw + 'px;background:' + bc + '"></div></div><span class="edge-val ' + ec + '">' + es + '</span></div></td>'
        + '<td class="r" data-label="EV">' + (evGated ? evH : '<span style="filter:blur(4px);font-family:var(--mono);font-size:12px;font-weight:600;color:var(--green);user-select:none">+8.4%</span><span style="font-size:9px;font-weight:700;background:var(--accent);color:#fff;border-radius:3px;padding:1px 4px;margin-left:3px;vertical-align:middle">PRO</span>') + '</td>'
        + '<td class="r adv-col" data-label="Units">' + uH + '</td>'
        + '<td class="r" data-label="Bet">' + bH + '</td>'
        + '<td class="c"><input type="checkbox" data-id="' + r.id + '" ' + (betTaken[r.id] ? 'checked' : '') + ' onchange="toggleBet(\'' + r.id + '\')" style="width:16px;height:16px;cursor:pointer;accent-color:var(--green)"></td>'
        + '</tr>';
    }

    function setLine(input) {
        var id = input.getAttribute('data-id');
        yourLines[id] = input.value !== '' ? parseFloat(input.value) : null;
        input.classList.toggle('line-changed', yourLines[id] != null);
        var tr = input.closest('tr');
        if (!tr) return;
        var r = rawRows.find(function(x) { return x.id === id; });
        if (!r) return;
        var fair = getFair(r);
        var af = adjFair(fair, r.pt, yourLines[id], r.mkt, r.ps);
        var changed = (yourLines[id] != null && r.pt != null && parseFloat(yourLines[id]) !== parseFloat(r.pt));
        var tds = tr.querySelectorAll('td');
        tds[7].textContent = af != null ? (af * 100).toFixed(1) + '%' : '-';
        tds[7].style.cssText = 'text-align:right;font-family:var(--mono);color:' + (changed ? 'var(--yellow)' : 'var(--muted)');
        var inputs = tr.querySelectorAll('input[data-id="' + id + '"]');
        if (inputs.length > 1) setPred(inputs[inputs.length - 1]);
    }

    var _settingPred = false;

    function setPred(input) {
        var id = input.getAttribute('data-id');
        preds[id] = input.value;
        delete probsExact[id];
        input.classList.toggle('filled', !!input.value);

        var r = rawRows.find(function(x) { return x.id === id; });

        if (!_settingPred && r && !r._wcFair && (r.mkt === 'Total' || r.mkt === 'ML' || r.mkt === 'RFI' || r.mkt === 'Spread') && input.value !== '') {
            var v = parseFloat(input.value);
            if (!isNaN(v) && v >= 1 && v <= 99) {
                var otherId = r.ps === 'A' ? id.replace(/-A$/, '-B') : id.replace(/-B$/, '-A');
                var other = (100 - v).toFixed(1);
                preds[otherId] = other;
                var allOther = document.querySelectorAll('td[data-label="Real %"] input[data-id="' + otherId + '"]');
                var otherInp = allOther.length ? allOther[0] : null;
                if (otherInp && otherInp !== input) {
                    otherInp.value = other;
                    otherInp.classList.add('filled');
                    _settingPred = true;
                    setPred(otherInp);
                    _settingPred = false;
                }
            }
        }

        var tr = input.closest('tr');
        if (!tr) return;
        if (!r) return;
        var yl = yourLines[id] != null ? yourLines[id] : null;
        var fair, af;
        if (r._wcFair != null) {
            fair = r._wcFair;
            af   = r._wcFair;
        } else if (r.mkt === 'RFI' && r.rfiFair != null) {
            fair = r.rfiFair;
            af   = r.rfiFair;
        } else {
            var _pairs = {};
            rawRows.forEach(function(x) { if (!_pairs[x.pid]) _pairs[x.pid] = {}; _pairs[x.pid][x.ps] = x; });
            var _p = _pairs[r.pid] || {};
            var _nv = novig(_p.A ? imp(_p.A.am) : null, _p.B ? imp(_p.B.am) : null);
            var _altNV = getAltFair(r, yl, _p.A, _p.B);
            fair = _altNV ? (r.ps === 'A' ? _altNV.fa : _altNV.fb) : (r.ps === 'A' ? _nv.fa : _nv.fb);
            af = _altNV ? fair : adjFair(fair, r.pt, yl, r.mkt, r.ps);
        }
        var pred = input.value !== '' ? Math.min(0.999, Math.max(0.001, (probsExact[id] != null ? probsExact[id] : parseFloat(input.value) / 100) + rsPredAdj / 100)) : null;
        var edge = (af != null && pred != null && isFinite(pred)) ? (af - pred) * 100 : null;
        var evForUnits = null, evH = '-';
        if (af != null && pred != null && pred > 0 && pred < 1) {
            evForUnits = (af * (1/pred) * (1-rsBaseTake(pred)) - 1) * 100;
            if (isPro() || r.mkt === 'ML') {
                var evColor = evForUnits >= 5 ? 'var(--green)' : evForUnits > 0 ? 'var(--yellow)' : 'var(--red)';
                evH = '<span style="font-family:var(--mono);font-size:12px;font-weight:600;color:' + evColor + '">' + (evForUnits > 0 ? '+' : '') + evForUnits.toFixed(1) + '%</span>';
            } else {
                evH = '<span style="filter:blur(4px);font-family:var(--mono);font-size:12px;font-weight:600;color:var(--green);user-select:none">+8.4%</span><span style="font-size:9px;font-weight:700;background:var(--accent);color:#fff;border-radius:3px;padding:1px 4px;margin-left:3px;vertical-align:middle">PRO</span>';
            }
        }
        var u = (isPro() || r.mkt === 'ML' || r.mkt === 'RFI') ? unitsEV(evForUnits, pred) : units(edge);
        var unit = parseFloat(document.getElementById('unit-size').value) || 300;
        var es = '-', ec = 'e-none', bw = 0, bc = 'var(--muted2)';
        if (edge != null) {
            es = (edge > 0 ? '+' : '') + edge.toFixed(1) + '%';
            if (edge >= 8) { ec = 'e-strong'; bc = 'var(--green)'; }
            else if (edge >= 5) { ec = 'e-med'; bc = '#7ddfab'; }
            else if (edge > 0) { ec = 'e-weak'; bc = 'var(--yellow)'; }
            else { ec = 'e-neg'; bc = 'var(--red)'; }
            bw = Math.min(Math.abs(edge) * 5, 50);
        }
        var tdEdge  = tr.querySelector('td[data-label="Edge"]');
        var tdEV    = tr.querySelector('td[data-label="EV"]');
        var tdUnits = tr.querySelector('td[data-label="Units"]');
        var tdBet   = tr.querySelector('td[data-label="Bet"]');
        if (tdEdge)  tdEdge.innerHTML  = '<div class="edge-wrap"><div class="edge-bar-bg"><div class="edge-bar-fill" style="width:' + bw + 'px;background:' + bc + '"></div></div><span class="edge-val ' + ec + '">' + es + '</span></div>';
        if (tdEV)    tdEV.innerHTML    = evH;
        if (tdUnits) tdUnits.innerHTML = u === 0 ? '<span class="u-pass">PASS</span>' : '<span class="u-val">' + u + 'u</span>';
        if (tdBet)   tdBet.innerHTML   = u === 0 ? '<span class="u-pass">-</span>' : '<span class="bet-val">' + RAX_ICON + (u * unit).toFixed(0) + '</span>';
        tr.classList.toggle('has-edge', edge != null && edge > 0);
        tr.style.background = edge != null && edge > 0 ? 'rgba(45,204,126,' + (Math.min(edge / 10, 1) * 0.08).toFixed(3) + ')' : '';
        var _se = document.getElementById('stat-edges'); if (_se) _se.textContent = document.querySelectorAll('tr.has-edge').length;
    }

    // ── REAL SPORTS AUTO-FILL ──
    var ABBREV_MAP = {
        'ATL': 'Atlanta Hawks', 'BOS': 'Boston Celtics', 'BKN': 'Brooklyn Nets',
        'CHA': 'Charlotte Hornets', 'CHI': 'Chicago Bulls', 'CLE': 'Cleveland Cavaliers',
        'DAL': 'Dallas Mavericks', 'DEN': 'Denver Nuggets', 'DET': 'Detroit Pistons',
        'GSW': 'Golden State Warriors', 'HOU': 'Houston Rockets', 'IND': 'Indiana Pacers',
        'LAC': 'LA Clippers', 'LAL': 'Los Angeles Lakers', 'MEM': 'Memphis Grizzlies',
        'MIA': 'Miami Heat', 'MIL': 'Milwaukee Bucks', 'MIN': 'Minnesota Timberwolves',
        'NOP': 'New Orleans Pelicans', 'NYK': 'New York Knicks', 'OKC': 'Oklahoma City Thunder',
        'ORL': 'Orlando Magic', 'PHI': 'Philadelphia 76ers', 'PHX': 'Phoenix Suns',
        'POR': 'Portland Trail Blazers', 'SAC': 'Sacramento Kings', 'SAS': 'San Antonio Spurs',
        'TOR': 'Toronto Raptors', 'UTA': 'Utah Jazz', 'WAS': 'Washington Wizards',
        // NHL
        'ANA': 'Anaheim Ducks', 'ARI': 'Arizona Coyotes', 'BUF': 'Buffalo Sabres',
        'CGY': 'Calgary Flames', 'CAR': 'Carolina Hurricanes', 'CBJ': 'Columbus Blue Jackets',
        'COL': 'Colorado Avalanche', 'DAL': 'Dallas Stars', 'EDM': 'Edmonton Oilers',
        'FLA': 'Florida Panthers', 'LAK': 'Los Angeles Kings', 'MIN': 'Minnesota Wild',
        'MTL': 'Montreal Canadiens', 'NSH': 'Nashville Predators', 'NJD': 'New Jersey Devils',
        'NYI': 'New York Islanders', 'NYR': 'New York Rangers', 'OTT': 'Ottawa Senators',
        'PHI': 'Philadelphia Flyers', 'PIT': 'Pittsburgh Penguins', 'SEA': 'Seattle Kraken',
        'SJS': 'San Jose Sharks', 'STL': 'St. Louis Blues', 'TBL': 'Tampa Bay Lightning',
        'TOR': 'Toronto Maple Leafs', 'VAN': 'Vancouver Canucks', 'VGK': 'Vegas Golden Knights',
        'WSH': 'Washington Capitals', 'WPG': 'Winnipeg Jets',
        // MLB
        'ARI': 'Arizona Diamondbacks', 'ATL': 'Atlanta Braves', 'BAL': 'Baltimore Orioles',
        'BOS': 'Boston Red Sox', 'CHC': 'Chicago Cubs', 'CWS': 'Chicago White Sox',
        'CIN': 'Cincinnati Reds', 'CLE': 'Cleveland Guardians', 'COL': 'Colorado Rockies',
        'DET': 'Detroit Tigers', 'HOU': 'Houston Astros', 'KC': 'Kansas City Royals', 'KCR': 'Kansas City Royals',
        'LAA': 'Los Angeles Angels', 'LAD': 'Los Angeles Dodgers', 'MIA': 'Miami Marlins',
        'MIL': 'Milwaukee Brewers', 'MIN': 'Minnesota Twins', 'NYM': 'New York Mets',
        'NYY': 'New York Yankees', 'OAK': 'Oakland Athletics', 'PHI': 'Philadelphia Phillies',
        'PIT': 'Pittsburgh Pirates', 'SDP': 'San Diego Padres', 'SD': 'San Diego Padres', 'SFG': 'San Francisco Giants', 'SF': 'San Francisco Giants',
        'SEA': 'Seattle Mariners', 'STL': 'St. Louis Cardinals', 'TB': 'Tampa Bay Rays', 'TBR': 'Tampa Bay Rays',
        'TEX': 'Texas Rangers', 'TOR': 'Toronto Blue Jays', 'WSN': 'Washington Nationals',
        // College (CWS / ncaabb) — RS uses abbreviations for some schools
        'UNC': 'North Carolina', 'WVU': 'West Virginia', 'UGA': 'Georgia',
        'LSU': 'LSU', 'TCU': 'TCU', 'OU': 'Oklahoma', 'OSU': 'Oklahoma State',
        'FSU': 'Florida State', 'UCF': 'UCF', 'USF': 'South Florida',
        'USC': 'USC', 'UCLA': 'UCLA', 'TENN': 'Tennessee', 'ARK': 'Arkansas',
        'MISS': 'Mississippi', 'MSST': 'Mississippi State', 'AUB': 'Auburn'
    };

    function resolveTeamName(abbrevOrName) {
        // Case-sensitive nickname map for hyphenated/mixed-case names Real Sports uses
        var NICKNAMES = {
            'D-backs': 'Arizona Diamondbacks',
            'Dbacks': 'Arizona Diamondbacks',
            'Dodgers': 'Los Angeles Dodgers',
            'Yankees': 'New York Yankees',
            'Mets': 'New York Mets',
            'Cubs': 'Chicago Cubs',
            'Sox': null, // ambiguous, skip
            'Red Sox': 'Boston Red Sox',
            'White Sox': 'Chicago White Sox',
            'Wolves': 'Minnesota Timberwolves',
            'Sixers': 'Philadelphia 76ers',
            'Mavs': 'Dallas Mavericks',
            'Spurs': 'San Antonio Spurs',
            'Bulls': 'Chicago Bulls',
            'Pistons': 'Detroit Pistons',
            'Bucks': 'Milwaukee Bucks',
            'Grizzlies': 'Memphis Grizzlies',
            'Hornets': 'Charlotte Hornets',
            'Hawks': 'Atlanta Hawks',
            'Heat': 'Miami Heat',
            'Magic': 'Orlando Magic',
            'Nets': 'Brooklyn Nets',
            'Knicks': 'New York Knicks',
            'Celtics': 'Boston Celtics',
            'Raptors': 'Toronto Raptors',
            'Wizards': 'Washington Wizards',
            'Cavaliers': 'Cleveland Cavaliers',
            'Pacers': 'Indiana Pacers',
            'Pistons': 'Detroit Pistons',
            'Nuggets': 'Denver Nuggets',
            'Thunder': 'Oklahoma City Thunder',
            'Blazers': 'Portland Trail Blazers',
            'Kings': 'Sacramento Kings',
            'Suns': 'Phoenix Suns',
            'Jazz': 'Utah Jazz',
            'Clippers': 'LA Clippers',
            'LA Clippers': 'LA Clippers',
            'Los Angeles Clippers': 'LA Clippers',
            'Lakers': 'Los Angeles Lakers',
            'Warriors': 'Golden State Warriors',
            'Rockets': 'Houston Rockets',
            'Pelicans': 'New Orleans Pelicans',
            'Timberwolves': 'Minnesota Timberwolves',
            // NHL
            'Bruins': 'Boston Bruins',
            'Sabres': 'Buffalo Sabres',
            'Flames': 'Calgary Flames',
            'Hurricanes': 'Carolina Hurricanes',
            'Blackhawks': 'Chicago Blackhawks',
            'Avalanche': 'Colorado Avalanche',
            'Blue Jackets': 'Columbus Blue Jackets',
            'Stars': 'Dallas Stars',
            'Red Wings': 'Detroit Red Wings',
            'Oilers': 'Edmonton Oilers',
            'Panthers': 'Florida Panthers',
            'Kings': 'Los Angeles Kings',
            'Wild': 'Minnesota Wild',
            'Canadiens': 'Montreal Canadiens',
            'Predators': 'Nashville Predators',
            'Devils': 'New Jersey Devils',
            'Islanders': 'New York Islanders',
            'Rangers': 'New York Rangers',
            'Senators': 'Ottawa Senators',
            'Flyers': 'Philadelphia Flyers',
            'Coyotes': 'Arizona Coyotes',
            'Penguins': 'Pittsburgh Penguins',
            'Blues': 'St. Louis Blues',
            'Lightning': 'Tampa Bay Lightning',
            'Maple Leafs': 'Toronto Maple Leafs',
            'Canucks': 'Vancouver Canucks',
            'Golden Knights': 'Vegas Golden Knights',
            'Capitals': 'Washington Capitals',
            'Jets': 'Winnipeg Jets',
            'Kraken': 'Seattle Kraken',
            'Ducks': 'Anaheim Ducks',
            'Sharks': 'San Jose Sharks'
        };
        // FC soccer overrides: some nicknames collide with NBA/NFL teams — handle before NICKNAMES lookup
        if (currentSport === 'soccer_fc' || currentSport === 'soccer_wc') {
            var FC_NICKS = {
                'Spurs': 'Tottenham Hotspur',
                'Hotspur': 'Tottenham Hotspur',
                'Hotspurs': 'Tottenham Hotspur',
                'Villa': 'Aston Villa',
            };
            if (FC_NICKS.hasOwnProperty(abbrevOrName)) return FC_NICKS[abbrevOrName];
        }
        if (NICKNAMES.hasOwnProperty(abbrevOrName) && NICKNAMES[abbrevOrName]) {
            return NICKNAMES[abbrevOrName];
        }
        // If it's already a full name (contains space) and not in NICKNAMES, return as-is
        if (abbrevOrName.indexOf(' ') !== -1) return abbrevOrName;
        var key = abbrevOrName.toUpperCase();
        // Sport-specific overrides for conflicting abbreviations
        var SPORT_OVERRIDES = {
            'icehockey_nhl': { 'STL': 'St. Louis Blues' },
            'baseball_mlb':  { 'STL': 'St. Louis Cardinals', 'TB': 'Tampa Bay Rays' }
        };
        var overrides = SPORT_OVERRIDES[currentSport] || {};
        return overrides[key] || ABBREV_MAP[key] || abbrevOrName;
    }

    // Fetch actual RS expected payout for ML rows via the CF payout proxy (D1-cached 30s).
    // Only runs after fetchRealMarkets has set rsMarketIds/rsOutcomeKeys. ML rows only —
    // non-ML payout values were unreliable. Sanity-checks result: discards if EV < -20%.
    function fetchExactEvForRows(sport) {
        var amount = Math.round(parseFloat(document.getElementById('unit-size').value) || 300);
        var sportRows = rawRowsBySport[sport] || rawRows;
        var pairs = {};
        sportRows.forEach(function(x) { if (!pairs[x.pid]) pairs[x.pid] = {}; pairs[x.pid][x.ps] = x; });
        var batch = sportRows.filter(function(r) {
            if (!rsMarketIds[r.id] || !rsOutcomeKeys[r.id] || !rsGameIds[r.game]) return false;
            var pr = preds[r.id]; if (!pr) return false;
            var pred = parseFloat(pr) / 100; if (pred <= 0 || pred >= 1) return false;
            var p = pairs[r.pid] || {};
            var nv = novig(p.A ? imp(p.A.am) : null, p.B ? imp(p.B.am) : null);
            var af = r.ps === 'A' ? nv.fa : nv.fb;
            return af != null && (af * (1/pred) * (1 - rsBaseTake(pred)) - 1) > 0;
        }).slice(0, 10);
        if (!batch.length) return;
        Promise.all(batch.map(function(r) {
            var sp = rsGameSports[r.game] || sport.split('_')[1] || 'mlb';
            var qs = 'marketId=' + rsMarketIds[r.id]
                   + '&outcomeKey=' + encodeURIComponent(rsOutcomeKeys[r.id])
                   + '&rsGameId='   + rsGameIds[r.game]
                   + '&rsSport='    + sp
                   + '&amount='     + amount;
            return fetch('/api/real/payout?' + qs, { credentials: 'same-origin', signal: AbortSignal.timeout(8000) })
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    if (!data.ok || data.expectedPayout <= 0) return;
                    var p = pairs[r.pid] || {};
                    var nv = novig(p.A ? imp(p.A.am) : null, p.B ? imp(p.B.am) : null);
                    var af = r.ps === 'A' ? nv.fa : nv.fb;
                    if (!af) return;
                    if ((af * data.expectedPayout / amount - 1) * 100 < 0) return;
                    payoutRatios[r.id] = data.expectedPayout / amount;
                })
                .catch(function() {});
        })).then(function() { renderTable(); });
    }

    function fetchKalshiRFI(skipRender) {
        return fetch('/api/fd/rfi', { credentials: 'same-origin' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (!d.ok || !d.rfi) return;
            rfiOdds = {};
            var kalshiKeys = Object.keys(d.rfi);

            // Match each FD game to a Kalshi RFI entry
            var gamesSeen = {};
            rawRows.forEach(function(r) {
                if (gamesSeen[r.game] || r.mkt === 'RFI') return;
                gamesSeen[r.game] = true;

                // 1. Direct lookup — worker now outputs FD-compatible full names
                if (d.rfi[r.game]) {
                    rfiOdds[r.game] = d.rfi[r.game];
                    return;
                }

                // 2. Fuzzy fallback — last word of each team name
                var fdTeams = r.game.split(' @ ');
                var fdAway = (fdTeams[0] || '').toLowerCase();
                var fdHome = (fdTeams[1] || '').toLowerCase();
                var match = kalshiKeys.find(function(k) {
                    var p = k.split(' @ ');
                    if (p.length !== 2) return false;
                    var ka = p[0].toLowerCase(), kh = p[1].toLowerCase();
                    var awayMatch = ka.split(' ').some(function(w) { return w.length > 2 && fdAway.indexOf(w) !== -1; })
                                 || fdAway.split(' ').some(function(w) { return w.length > 2 && ka.indexOf(w) !== -1; });
                    var homeMatch = kh.split(' ').some(function(w) { return w.length > 2 && fdHome.indexOf(w) !== -1; })
                                 || fdHome.split(' ').some(function(w) { return w.length > 2 && kh.indexOf(w) !== -1; });
                    return awayMatch && homeMatch;
                });
                if (match) rfiOdds[r.game] = d.rfi[match];
            });

            // Synthesize RFI rows — remove stale ones first
            rawRows = rawRows.filter(function(r) { return r.mkt !== 'RFI'; });
            Object.keys(rfiOdds).forEach(function(game) {
                var rfi = rfiOdds[game];
                var existing = rawRows.find(function(r) { return r.game === game; });
                if (!existing) return;
                var today = new Date(); var dateStr = today.getFullYear() + '' + (today.getMonth()+1) + '' + today.getDate();
                var pid = 'rfi-' + game.replace(/[^a-z0-9]/gi, '') + '-' + dateStr;
                rawRows.push({ id: pid + '-A', game: game, cm: existing.cm, mkt: 'RFI', side: 'Yes (YRFI)', am: rfi.yesAm, pt: null, pid: pid, ps: 'A', gid: existing.gid, rfiFair: rfi.yesFair });
                rawRows.push({ id: pid + '-B', game: game, cm: existing.cm, mkt: 'RFI', side: 'No (NRFI)',  am: rfi.noAm,  pt: null, pid: pid, ps: 'B', gid: existing.gid, rfiFair: rfi.noFair });
            });

            // Apply Real Sports preds to new RFI rows using already-fetched sync data
            // (avoids a second network call that would hit a stale D1 cache)
            var syncD = lastSyncData[currentSport];
            if (syncD && syncD.markets) {
                var mKeys = Object.keys(syncD.markets);
                rawRows.forEach(function(r) {
                    if (r.mkt !== 'RFI') return;
                    // Find Real Sports game key matching this RFI row
                    var realKey = syncD.markets[r.game] ? r.game : null;
                    if (!realKey) {
                        // DH pre-fuzzy: translate FD "(Game N)" suffix to RS " (2)" format
                        var _rfiDhM = r.game.match(/^(.+?)\s*\(Game (\d+)\)$/);
                        if (_rfiDhM) {
                            var _rfiBase = _rfiDhM[1].trim(), _rfiN = parseInt(_rfiDhM[2]);
                            if (_rfiN >= 2 && syncD.markets[_rfiBase + ' (2)']) realKey = _rfiBase + ' (2)';
                            else if (_rfiN === 1 && syncD.markets[_rfiBase]) realKey = _rfiBase;
                        }
                    }
                    if (!realKey) {
                        // Strip (Game N) so team name matching isn't polluted by the suffix
                        var _rfiGameBase = r.game.replace(/\s*\(Game \d+\)/, '').trim();
                        var fdTeams = _rfiGameBase.split(' @ ');
                        var fdAway = (fdTeams[0] || '').toLowerCase();
                        var fdHome = (fdTeams[1] || '').toLowerCase();
                        var found = mKeys.find(function(k) {
                            if (k.endsWith('__lines') || k.endsWith('__gid')) return false;
                            var kBase = k.endsWith(' (2)') ? k.slice(0, -4) : k;
                            var p = kBase.split(' @ ');
                            if (p.length !== 2) return false;
                            // Resolve Real Sports nicknames/abbreviations (e.g. "D-backs" → "Arizona Diamondbacks")
                            var ka = resolveTeamName(p[0].trim()).toLowerCase(), kh = resolveTeamName(p[1].trim()).toLowerCase();
                            var awayOk = ka.split(' ').some(function(w) { return w.length > 2 && fdAway.indexOf(w) !== -1; })
                                      || fdAway.split(' ').some(function(w) { return w.length > 2 && ka.indexOf(w) !== -1; });
                            var homeOk = kh.split(' ').some(function(w) { return w.length > 2 && fdHome.indexOf(w) !== -1; })
                                      || fdHome.split(' ').some(function(w) { return w.length > 2 && kh.indexOf(w) !== -1; });
                            return awayOk && homeOk;
                        });
                        if (found) {
                            // DH-awareness: Game 2 RFI rows must use RS ' (2)' key, not Game 1's
                            var _isRfiDH2 = /\(Game [2-9]/.test(r.game);
                            if (_isRfiDH2 && !found.endsWith(' (2)')) {
                                if (mKeys.indexOf(found + ' (2)') !== -1) found = found + ' (2)';
                                else found = null;
                            }
                            if (found) realKey = found;
                        }
                    }
                    if (!realKey) return;
                    var gameMkts = syncD.markets[realKey];
                    if (!gameMkts) return;
                    var mktData = gameMkts['Run in 1st inning?'];
                    if (!mktData) return;
                    var outcomes = mktData.outcomes || mktData;
                    if (!outcomes || !outcomes.length) return;
                    var isYes = r.ps === 'A';
                    var match = outcomes.find(function(o) {
                        if (!o.label) return false;
                        return isYes ? o.label.toLowerCase() === 'yes' : o.label.toLowerCase() === 'no';
                    });
                    if (!match) match = isYes ? outcomes[1] : outcomes[0];
                    if (match && match.pct != null) {
                        preds[r.id] = String(match.pct);
                        if (match.probability != null) probsExact[r.id] = match.probability;
                        if (mktData.volumeDisplay) vols[r.id] = mktData.volumeDisplay;
                    }
                });
            }

            if (!skipRender) renderTable();
        })
        .catch(function() {});
    }

    function fetchRealMarkets(sport, skipRender) {
        return fetch('/api/real/sync?sport=' + sport, { credentials: 'same-origin' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (!d.ok || !d.markets) return;
            var marketKeys = Object.keys(d.markets);

            // Nickname overrides for Real Sports game keys that don't resolve via ABBREV_MAP
            var NICKNAME_MAP = {
                'D-backs': 'Arizona Diamondbacks',
                'Dbacks': 'Arizona Diamondbacks',
                'Sox': null, // ambiguous — handled by context
                'Wolves': 'Minnesota Timberwolves',
                'Sixers': 'Philadelphia 76ers',
                'Mavs': 'Dallas Mavericks',
                'Nugs': 'Denver Nuggets'
            };
            function resolveNickname(name) {
                return NICKNAME_MAP[name] || resolveTeamName(name);
            }

            // Normalize accented characters to ASCII for fuzzy matching
            function norm(s) {
                return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
            }

            // Build a resolved map: full name game key -> original Real key
            var resolvedMap = {};
            marketKeys.forEach(function(k) {
                if (k.endsWith('__lines')) return;
                // Strip " (2)" before resolving team names so the suffix doesn't corrupt abbreviation lookup
                var dhSuffix = k.endsWith(' (2)') ? ' (2)' : '';
                var kBase = dhSuffix ? k.slice(0, -4) : k;
                var parts = kBase.split(' @ ');
                if (parts.length !== 2) return;
                var resolvedKey = resolveNickname(parts[0].trim()) + ' @ ' + resolveNickname(parts[1].trim()) + dhSuffix;
                resolvedMap[resolvedKey] = k;
                resolvedMap[k] = k; // also keep original
            });

            // For MMA, filter rawRows to only UFC fights (those that exist in Real Sports)
            // Only filter if RS actually returned fights — if marketKeys is empty, RS has no data for this card
            // and we still want to show FD odds (even without RS preds).
            var _mmaLast = function(n) { var _sfx={'jr.':1,'sr.':1,'jr':1,'sr':1,'ii':1,'iii':1,'iv':1}; var p=n.split(' '); while(p.length>1&&_sfx[p[p.length-1]])p.pop(); return p[p.length-1]||''; };
            if (sport === 'mma_mixed_martial_arts' && marketKeys.length > 0) {
                rawRows = rawRows.filter(function(r) {
                    if (resolvedMap[r.game]) return true;
                    var fdTeams = r.game.split(' @ ');
                    var fdAway = fdTeams[0] ? fdTeams[0].toLowerCase() : '';
                    var fdHome = fdTeams[1] ? fdTeams[1].toLowerCase() : '';
                    var fdAwayLast = _mmaLast(fdAway);
                    var fdHomeLast = _mmaLast(fdHome);
                    return marketKeys.some(function(k) {
                        if (k.endsWith('__lines') || k.endsWith('__gid')) return false;
                        var realTeams = k.split(' @ ');
                        if (realTeams.length !== 2) return false;
                        var rAway = realTeams[0].trim().toLowerCase();
                        var rHome = realTeams[1].trim().toLowerCase();
                        var rAwayLast = _mmaLast(rAway);
                        var rHomeLast = _mmaLast(rHome);
                        // Check both orientations — FD and Real Sports sometimes flip home/away
                        var normalMatch = (rAwayLast.indexOf(fdAwayLast) !== -1 || fdAwayLast.indexOf(rAwayLast) !== -1)
                                       && (rHomeLast.indexOf(fdHomeLast) !== -1 || fdHomeLast.indexOf(rHomeLast) !== -1);
                        var flippedMatch = (rAwayLast.indexOf(fdHomeLast) !== -1 || fdHomeLast.indexOf(rAwayLast) !== -1)
                                        && (rHomeLast.indexOf(fdAwayLast) !== -1 || fdAwayLast.indexOf(rHomeLast) !== -1);
                        return normalMatch || flippedMatch;
                    });
                });
                if (!skipRender) renderTable();
            }

            rawRows.forEach(function(r) {
                // Try exact match first, then resolved abbreviation match
                var realKey = resolvedMap[r.game];

                // Doubleheader: FD uses "(Game N)" suffix, RS uses one key per matchup (short nicknames)
                // Try resolved base key and (2) key first; then fall through to fuzzy.
                if (!realKey) {
                    var _dhm = r.game.match(/\(Game (\d+)\)/);
                    if (_dhm) {
                        var _dhBase = r.game.replace(/\s*\(Game \d+\)/, '').trim();
                        var _dhNum = parseInt(_dhm[1]);
                        if (_dhNum >= 2) {
                            if (resolvedMap[_dhBase + ' (2)']) realKey = resolvedMap[_dhBase + ' (2)'];
                            else if (resolvedMap[_dhBase]) realKey = resolvedMap[_dhBase];
                            // else: fall through to fuzzy — RS uses short nicknames so exact resolved fails
                        } else {
                            if (resolvedMap[_dhBase]) realKey = resolvedMap[_dhBase];
                        }
                    }
                }

                // Fallback: fuzzy word match — strip (Game N) so it doesn't pollute team name matching
                if (!realKey) {
                    var _fuzzyGame = r.game.replace(/\s*\(Game \d+\)/, '').trim();
                    var fdTeams = _fuzzyGame.split(' @ ');
                    var fdAway = norm(fdTeams[0] || '');
                    var fdHome = norm(fdTeams[1] || '');
                    var fdAwayLast = _mmaLast(fdAway);
                    var fdHomeLast = _mmaLast(fdHome);
                    var matched = marketKeys.find(function(k) {
                        if (k.endsWith('__lines') || k.endsWith('__gid')) return false;
                        var realTeams = k.split(' @ ');
                        if (realTeams.length !== 2) return false;
                        var rAway = norm(resolveTeamName(realTeams[0].trim()));
                        var rHome = norm(resolveTeamName(realTeams[1].trim()));
                        var rAwayLast = _mmaLast(rAway);
                        var rHomeLast = _mmaLast(rHome);
                        // For MMA: check last names in both orientations
                        if (sport === 'mma_mixed_martial_arts') {
                            var normalMatch = (rAwayLast.indexOf(fdAwayLast) !== -1 || fdAwayLast.indexOf(rAwayLast) !== -1)
                                           && (rHomeLast.indexOf(fdHomeLast) !== -1 || fdHomeLast.indexOf(rHomeLast) !== -1);
                            var flippedMatch = (rAwayLast.indexOf(fdHomeLast) !== -1 || fdHomeLast.indexOf(rAwayLast) !== -1)
                                            && (rHomeLast.indexOf(fdAwayLast) !== -1 || fdAwayLast.indexOf(rHomeLast) !== -1);
                            return normalMatch || flippedMatch;
                        }
                        // Soccer: RS uses short names ("Atlético") vs DK full names ("Atletico Madrid")
                        // Any word from RS name appearing in DK name (or vice versa) is a match.
                        // Exclude geographic direction words — "south" must not match across "South Korea" / "South Africa".
                        var _gs = { south: 1, north: 1, east: 1, west: 1, central: 1, new: 1 };
                        var _wcA = {
                            'usa': 'united states', 'united states': 'usa',
                            'turkiye': 'turkey', 'turkey': 'turkiye',
                            "cote d'ivoire": 'ivory coast', 'ivory coast': "cote d'ivoire",
                            // FIFA 3-letter codes RS uses for national teams
                            'arg': 'argentina', 'argentina': 'arg',
                            'esp': 'spain',     'spain': 'esp',
                            'fra': 'france',    'france': 'fra',
                            'bra': 'brazil',    'brazil': 'bra',
                            'ger': 'germany',   'germany': 'ger',
                            'por': 'portugal',  'portugal': 'por',
                            'ned': 'netherlands','netherlands': 'ned',
                            'eng': 'england',   'england': 'eng',
                            'ita': 'italy',     'italy': 'ita',
                            'mex': 'mexico',    'mexico': 'mex',
                            'mor': 'morocco',   'morocco': 'mor',
                            'jpn': 'japan',     'japan': 'jpn',
                            'aus': 'australia', 'australia': 'aus',
                            'uru': 'uruguay',   'uruguay': 'uru',
                            'col': 'colombia',  'colombia': 'col',
                            'cro': 'croatia',   'croatia': 'cro',
                            'sen': 'senegal',   'senegal': 'sen',
                            'mar': 'morocco',   'cmr': 'cameroon', 'cameroon': 'cmr',
                        };
                        var awayMatch = rAway.split(' ').some(function(w) { return w.length > 2 && !_gs[w] && fdAway.indexOf(w) !== -1; })
                                     || fdAway.split(' ').some(function(w) { return w.length > 2 && !_gs[w] && rAway.indexOf(w) !== -1; })
                                     || (!!_wcA[rAway] && (fdAway === _wcA[rAway] || fdAway.indexOf(_wcA[rAway]) !== -1))
                                     || (!!_wcA[fdAway] && (rAway === _wcA[fdAway] || rAway.indexOf(_wcA[fdAway]) !== -1));
                        var homeMatch = rHome.split(' ').some(function(w) { return w.length > 2 && !_gs[w] && fdHome.indexOf(w) !== -1; })
                                     || fdHome.split(' ').some(function(w) { return w.length > 2 && !_gs[w] && rHome.indexOf(w) !== -1; })
                                     || (!!_wcA[rHome] && (fdHome === _wcA[rHome] || fdHome.indexOf(_wcA[rHome]) !== -1))
                                     || (!!_wcA[fdHome] && (rHome === _wcA[fdHome] || rHome.indexOf(_wcA[fdHome]) !== -1));
                        return awayMatch && homeMatch;
                    });
                    if (matched) {
                        var _isFdDH2b = /\(Game [2-9]/.test(r.game);
                        if (_isFdDH2b && !matched.endsWith(' (2)')) {
                            if (marketKeys.indexOf(matched + ' (2)') !== -1) matched = matched + ' (2)';
                        } else if (!_isFdDH2b && matched.endsWith(' (2)')) {
                            var _matchedBase = matched.replace(/ \(2\)$/, '');
                            if (marketKeys.indexOf(_matchedBase) !== -1) matched = _matchedBase;
                        }
                        realKey = matched;
                    }
                }

                if (!realKey) return;
                var gameGid = d.markets[realKey + '__gid'];
                if (gameGid) rsGameIds[r.game] = gameGid;
                var gameStartMs = d.markets[realKey + '__startMs'];
                if (gameStartMs) rsGameStartMs[r.game] = gameStartMs;
                // Store RS-level sport key so getRealSportsUrl picks the right sport ID for deep links
                var gameRsSport = d.markets[realKey + '__sport'];
                if (gameRsSport) rsGameSports[r.game] = gameRsSport;
                var gameMarkets = d.markets[realKey];
                if (!gameMarkets) return;

                // Auto-fill Real Line from game-level pointSpread/overUnder
                // FC: skip RS spread line — RS may show a different handicap (not ±0.5); use pct instead (below)
                var gameLines = d.markets[realKey + '__lines'];
                if (gameLines && sport !== 'soccer_fc' && sport !== 'soccer_wc') {
                    if (r.mkt === 'Spread' && yourLines[r.id] == null) {
                        // Determine if this row is home or away side
                        var gameParts = r.game.split(' @ ');
                        var isHome = gameParts[1] && r.side.toLowerCase().indexOf(gameParts[1].split(' ').pop().toLowerCase()) !== -1;
                        var spreadVal = isHome ? gameLines.homeSpread : gameLines.awaySpread;
                        if (spreadVal != null) {
                            yourLines[r.id] = spreadVal;
                        }
                    }
                    if (r.mkt === 'Total' && yourLines[r.id] == null && gameLines.total != null) {
                        yourLines[r.id] = gameLines.total;
                    }
                }

                var mktLabel = r.mkt === 'ML' ? 'Game Winner'
                             : r.mkt === 'Spread' ? 'Spread'
                             : r.mkt === 'Total' ? 'Total'
                             : r.mkt === 'RFI' ? 'Run in 1st inning?'
                             : null;
                if (!mktLabel) return;
                var mktData = gameMarkets[mktLabel];
                // MMA: RS may use different label than "Game Winner" for fight winner market
                if (!mktData && sport === 'mma_mixed_martial_arts' && r.mkt === 'ML') {
                    mktData = gameMarkets['Fight Outcome'] || gameMarkets['Fight Winner']
                           || gameMarkets['Match Winner'] || gameMarkets['Winner']
                           || Object.values(gameMarkets)[0]; // last resort: first available market
                }
                // WC KO: RS may label the winner market various ways depending on round
                if (!mktData && sport === 'soccer_wc' && r.mkt === 'ML') {
                    mktData = gameMarkets['To Lift Cup'] || gameMarkets['To Win the Cup']
                           || gameMarkets['To Advance'] || gameMarkets['To Qualify'] || gameMarkets['To Progress']
                           || gameMarkets['Match Result'] || gameMarkets['1X2']
                           || gameMarkets['Home/Draw/Away'] || gameMarkets['Game Winner'];
                }
                var outcomes = mktData ? (mktData.outcomes || mktData) : null;
                if (!outcomes || !outcomes.length) return;

                var sideLower = r.side.toLowerCase();
                var sideWords = sideLower.split(' ').filter(function(w) { return w.length > 2; });

                // Pass 0: RFI-specific matching — Yes/No
                var match = null;
                if (r.mkt === 'RFI') {
                    var isYes = r.ps === 'A'; // A=Yes(YRFI), B=No(NRFI)
                    match = outcomes.find(function(o) {
                        if (!o.label) return false;
                        return isYes ? o.label.toLowerCase() === 'yes' : o.label.toLowerCase() === 'no';
                    });
                    if (!match) match = isYes ? outcomes[1] : outcomes[0]; // Real Sports: No=0, Yes=1
                }

                // Pass 0c: MMA last-name matching
                if (!match && sport === 'mma_mixed_martial_arts') {
                    var sideLast = sideLower.split(' ').pop();
                    match = outcomes.find(function(o) {
                        if (!o.label) return false;
                        var oLast = o.label.toLowerCase().split(' ').pop();
                        return oLast.indexOf(sideLast) !== -1 || sideLast.indexOf(oLast) !== -1;
                    });
                }

                // Pass 0b: Total-specific matching
                if (!match && r.mkt === 'Total') {
                    var isOver = sideLower === 'over';
                    match = outcomes.find(function(o) {
                        if (!o.label) return false;
                        var first = o.label.trim().charAt(0).toUpperCase();
                        return isOver ? first === 'O' : first === 'U';
                    });
                    // Fallback: use position - Over=A=outcomes[0], Under=B=outcomes[1]
                    if (!match) {
                        match = r.ps === 'A' ? outcomes[0] : outcomes[1];
                    }
                }

                // Pass 0d: Soccer FC spread — find -0.5 and +0.5 outcomes by label, then match this
                // team's name against both to determine which side RS assigned to this team.
                // This avoids positional fallback errors when RS returns outcomes in home-first order.
if (!match && r.mkt === 'Spread' && (sport === 'soccer_fc' || sport === 'soccer_wc')) {
                    // Also check o.line — RS outcome label is sometimes stripped of ±0.5 by team-key substitution,
                    // but the line field is extracted from the raw label before substitution and preserves it.
                    var fcMinusO = outcomes.find(function(o) { return o.line === -0.5 || (o.label && o.label.indexOf('-0.5') !== -1); });
                    var fcPlusO  = outcomes.find(function(o) { return o.line === 0.5  || (o.label && o.label.indexOf('+0.5') !== -1); });
                    if (fcMinusO || fcPlusO) {
                        var fcTeamLow = r.side.toLowerCase();
                        var _wcLblAliases = { 'usa': 'united states', 'united states': 'usa', "côte d'ivoire": 'ivory coast', 'ivory coast': "côte d'ivoire", 'curaçao': 'curacao', 'curacao': 'curaçao' };
                        var _fcGeoStop = { south: 1, north: 1, east: 1, west: 1, central: 1, new: 1 };
                        var fcTeamWords = fcTeamLow.split(' ').filter(function(w) { return w.length > 2 && !_fcGeoStop[w]; });
                        if (_wcLblAliases[fcTeamLow]) fcTeamWords = fcTeamWords.concat(_wcLblAliases[fcTeamLow].split(' ').filter(function(w) { return w.length > 2 && !_fcGeoStop[w]; }));
                        function fcLabelMatch(o) {
                            if (!o || !o.label) return false;
                            var lbl = o.label.toLowerCase().replace(/[+-]?\d+\.?\d*\s*$/, '').trim();
                            return fcTeamWords.some(function(w) { return lbl.indexOf(w) !== -1 || w.indexOf(lbl) !== -1; });
                        }
                        if (fcLabelMatch(fcMinusO)) {
                            match = fcMinusO;
                        } else if (fcLabelMatch(fcPlusO)) {
                            match = fcPlusO;
                        } else if (fcMinusO && fcPlusO) {
                            // Name matching failed — use DK favorite as tiebreaker:
                            // the team with the lower (more negative) DK -0.5 price is the assigned -0.5 side
                            var _hm = r._dkSpreads && r._dkSpreads.Home && r._dkSpreads.Home['-0.5'];
                            var _am = r._dkSpreads && r._dkSpreads.Away && r._dkSpreads.Away['-0.5'];
                            var homeFavored = _hm != null && _am != null ? _hm <= _am : _hm != null;
                            var fcIsHomeRow = r.ps === 'B';
                            match = (fcIsHomeRow === homeFavored) ? fcMinusO : fcPlusO;
                        } else {
                            match = fcMinusO || fcPlusO;
                        }
                    } else if (sport === 'soccer_wc' && outcomes.length === 2) {
                        // WC: RS may use "X Win or Draw" / "Y Win" format with no ±0.5 labels.
                        // "Win or Draw" = the +0.5 side (team doesn't need to win outright).
                        // "Win" (only) = the -0.5 side (team must win outright).
                        var _wodO = outcomes.find(function(o) { return /draw/i.test(o.rawLabel || o.label || ''); });
                        var _wonO = _wodO ? outcomes.find(function(o) { return o !== _wodO; }) : null;
                        if (_wodO && _wonO) {
                            var _rTeamLow = r.side.toLowerCase();
                            var _wcGeoStop2 = { south: 1, north: 1, east: 1, west: 1, central: 1, new: 1 };
                            var _rWords2  = _rTeamLow.split(' ').filter(function(w) { return w.length > 2 && !_wcGeoStop2[w]; });
                            var _wcAlias2 = ({'usa':'united states','united states':'usa','bih':'bosnia','bosnia':'bih','can':'canada','canada':'can',"côte d'ivoire":'ivory coast','ivory coast':"côte d'ivoire",'curaçao':'curacao','curacao':'curaçao','south korea':'kor','kor':'south korea','south africa':'rsa','rsa':'south africa','north macedonia':'mkd','mkd':'north macedonia','costa rica':'crc','crc':'costa rica'})[_rTeamLow] || '';
                            if (_wcAlias2) _rWords2 = _rWords2.concat(_wcAlias2.split(' ').filter(function(w) { return w.length > 2 && !_wcGeoStop2[w]; }));
                            function _wcLblHit(o) {
                                if (!o || !o.label) return false;
                                var lbl = o.label.toLowerCase();
                                return _rWords2.some(function(w) { return lbl.indexOf(w) !== -1; });
                            }
                            if (_wcLblHit(_wodO)) { match = _wodO; }
                            else if (_wcLblHit(_wonO)) { match = _wonO; }
                            else { match = r.ps === 'A' ? outcomes[0] : outcomes[1]; }
                        } else {
                            match = r.ps === 'A' ? outcomes[0] : outcomes[1];
                        }
                    } else {
                        // No ±0.5 labels — positional fallback
                        match = r.ps === 'A' ? outcomes[0] : outcomes[1];
                    }
                }

                // Pass 0e: WC Draw row — RS may use 'X', 'Draw', or 'Draw/Tie' for the draw outcome
                if (!match && sport === 'soccer_wc' && r.side === 'Draw') {
                    match = outcomes.find(function(o) {
                        if (!o.label) return false;
                        var ol = o.label.toLowerCase();
                        return ol === 'x' || ol === 'draw' || ol.indexOf('draw') !== -1 || ol.indexOf('tie') !== -1;
                    });
                    // Positional fallback: RS 3-way outcomes are typically [Away, Draw, Home] or [Home, Draw, Away]
                    if (!match && outcomes.length === 3) match = outcomes[1];
                }

                // Pass 1: exact word match or full label phrase in FD side
                // Use best-score (most matching words) rather than first-match to avoid ambiguous
                // shared words — e.g. both "Red Sox" and "White Sox" contain "sox", so first-match
                // would assign Boston's probability to Chicago.
                if (!match) {
                    var _p1best = null, _p1score = 0;
                    outcomes.forEach(function(o) {
                        if (!o.label) return;
                        var oLower = o.label.toLowerCase();
                        var oWords = oLower.split(' ').filter(function(w) { return w.length > 2; });
                        var phraseMatch = sideLower.indexOf(oLower) !== -1;
                        var wordScore = oWords.filter(function(ow) {
                            return sideWords.some(function(sw) { return sw === ow; });
                        }).length;
                        var score = (phraseMatch ? 10 : 0) + wordScore;
                        if (score > 0 && score > _p1score) { _p1best = o; _p1score = score; }
                    });
                    match = _p1best;
                }
                // Pass 2: resolve full label or leading abbreviation (e.g. "ATL +2.5" -> "Atlanta Hawks")
                if (!match) {
                    match = outcomes.find(function(o) {
                        if (!o.label) return false;
                        // Extract leading token before space/number (e.g. "ATL" from "ATL +2.5")
                        var token = o.label.split(/\s+/)[0];
                        var resolved = resolveTeamName(token).toLowerCase();
                        return sideWords.some(function(w) { return resolved.indexOf(w) !== -1; });
                    });
                }
                // Pass 3: full label resolve — best-score to avoid ambiguous shared words
                if (!match) {
                    var _p3best = null, _p3score = 0;
                    outcomes.forEach(function(o) {
                        if (!o.label) return;
                        var resolved = resolveTeamName(o.label).toLowerCase();
                        var score = sideWords.filter(function(w) { return resolved.indexOf(w) !== -1; }).length;
                        if (score > 0 && score > _p3score) { _p3best = o; _p3score = score; }
                    });
                    match = _p3best;
                }
                // Pass 4: last word of FD side name matches resolved token
                if (!match) {
                    var sideLastWord = sideLower.split(' ').pop();
                    match = outcomes.find(function(o) {
                        if (!o.label) return false;
                        var token = o.label.split(/\s+/)[0];
                        var resolved = resolveTeamName(token).toLowerCase();
                        return resolved.indexOf(sideLastWord) !== -1;
                    });
                }
                if (match && match.pct != null) {
                    preds[r.id] = String(match.pct);
                    if (match.probability != null) probsExact[r.id] = match.probability;
                    if (mktData && mktData.id != null) rsMarketIds[r.id] = mktData.id;
                    if (match.key) rsOutcomeKeys[r.id] = match.key;
                    if (mktData && mktData.volumeDisplay) {
                        vols[r.id] = mktData.volumeDisplay;
                        // Also set for the paired side (same game/market, opposite team)
                        var pairedId = r.id.endsWith('-A') ? r.id.slice(0, -2) + '-B' : r.id.slice(0, -2) + '-A';
                        vols[pairedId] = mktData.volumeDisplay;
                    }
                    // FC: use RS outcome label to directly pick the correct DK ±0.5 price.
                    // RS labels each side as "TEAM -0.5" or "TEAM +0.5" — trust that sign exactly.
                    // Never compute complements: 100 - pct gives the OPPONENT's probability, not this team's.
                    if ((sport === 'soccer_fc' || sport === 'soccer_wc') && r.mkt === 'Spread' && r._dkSpreads) {
                        // Use RS's actual line to look up the exact DK price at that line.
                        // match.line is extracted from the raw RS label (e.g. "MAN UTD -1.5" → -1.5)
                        // before any team-key substitution, so it's always correct.
                        var fcOutType = r.ps === 'B' ? 'Home' : 'Away';
                        var rsLine = match.line; // e.g. -1.5, -0.5, 0.5, 1.5
                        // WC uses "X Win or Draw" / "Y Win" labels (no ±0.5 literals).
                        // Infer line from label: "draw" in label = +0.5, "win" only = -0.5.
                        if (rsLine == null && sport === 'soccer_wc') {
                            var _wcRaw = match.rawLabel || match.label || '';
                            rsLine = /draw/i.test(_wcRaw) ? 0.5 : (/win/i.test(_wcRaw) ? -0.5 : null);
                        }
                        var dkSpr = (r._dkSpreads && r._dkSpreads[fcOutType]) || {};
                        var dkPrice2 = rsLine != null ? dkSpr[String(rsLine)] : null;
                        if (dkPrice2 != null) {
                            r.am = dkPrice2; r.pt = rsLine;
                        } else if (sport === 'soccer_wc' && rsLine != null && rsLine !== r.pt) {
                            // DK shifted the line mid-game (live flip) but RS still shows the
                            // pre-game line direction. Lock display to RS line and clear EV —
                            // comparing RS +0.5 prob vs DK -0.5 no-vig is a mismatch that
                            // produces false edges.
                            r.pt = rsLine;
                            delete preds[r.id];
                            delete probsExact[r.id];
                        }
                        if (rsLine != null) yourLines[r.id] = rsLine;
                    }
                }
                // Auto-fill Real Line from Real Sports outcome label (e.g. "ATL +6.5" -> 6.5)
                // FC: skip — line is already applied above via _dkSpreads lookup
                if (sport !== 'soccer_fc' && sport !== 'soccer_wc' && match && match.label && (r.mkt === 'Spread' || r.mkt === 'Total')) {
                    var lineMatch = match.label.match(/([+-]?\d+\.?\d*)\s*$/);
                    if (lineMatch) {
                        var lineVal = parseFloat(lineMatch[1]);
                        // Sanity check: spreads should be < 30, totals should end in .5 or be > 20 (NBA range)
                        // Values like 53/47 are probabilities, not lines — ignore them
                        var isValidLine = r.mkt === 'Spread'
                            ? (!isNaN(lineVal) && Math.abs(lineVal) < 30)
                            : (!isNaN(lineVal) && (lineVal % 1 === 0.5 || lineVal > 20) && lineVal <= 350);
                        // For spreads: require label contains letters (team name + spread like "OKC -3.5")
                        // A bare number label like "3" or "47" is a live probability, not a spread line
                        var labelHasTeamName = r.mkt !== 'Spread' || /[a-zA-Z]/.test(match.label);
                        if (isValidLine && labelHasTeamName) yourLines[r.id] = lineVal;
                    }
                }
            });
            lastSyncData[sport] = d;
            if (!skipRender) renderTable();
            // On mobile, fire input events on all auto-filled inputs to trigger edge display
            if (window.innerWidth <= 768) {
                setTimeout(function() {
                    document.querySelectorAll('.mc-inp[data-id][data-type="pred"]').forEach(function(inp) {
                        var id = inp.getAttribute('data-id');
                        if (preds[id] !== undefined && preds[id] !== '' && inp.value === '') {
                            inp.value = preds[id];
                            inp.classList.add('filled');
                        }
                        if (inp.value !== '') {
                            inp.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    });
                }, 150);
            }
            // On mobile, update edge result rows after auto-fill
            if (window.innerWidth <= 768) {
                var _rows = rawRows.slice(); // capture reference
                setTimeout(function() {
                    document.querySelectorAll('.mc-result').forEach(function(rr) {
                        var ids = (rr.getAttribute('data-section-id') || '').split(',');
                        // Find the first id in this section that has a pred
                        var activeId = null;
                        ids.forEach(function(id) {
                            if (id && preds[id] !== undefined && preds[id] !== '') activeId = id;
                        });
                        if (!activeId) return;
                        // Compute edge inline using captured rawRows
                        var r = _rows.find(function(x) { return x.id === activeId; });
                        if (!r) return;
                        var unit = parseFloat(document.getElementById('unit-size').value) || 300;
                        var pairs = {};
                        _rows.forEach(function(x) {
                            if (!pairs[x.pid]) pairs[x.pid] = {};
                            pairs[x.pid][x.ps] = x;
                        });
                        var pair = pairs[r.pid] || {};
                        var nv = novig(pair.A ? imp(pair.A.am) : null, pair.B ? imp(pair.B.am) : null);
                        var fair = r.ps === 'A' ? nv.fa : nv.fb;
                        var yl = yourLines[r.id] != null ? yourLines[r.id] : null;
                        var af = adjFair(fair, r.pt, yl, r.mkt, r.ps);
                        var pred = parseFloat(preds[activeId]) / 100;
                        var edge = (af != null && pred != null && isFinite(pred)) ? (af - pred) * 100 : null;
                        var evForUC = null;
                        if (af != null && pred != null && pred > 0 && pred < 1) {
                            evForUC = (af * (1/pred) * 0.966 - 1) * 100;
                        }
                        var u = (isPro() || r.mkt === 'ML' || r.mkt === 'RFI') ? unitsEV(evForUC, pred) : units(edge);
                        var bet = u * unit;
                        if (edge != null) {
                            var col = edge >= 8 ? 'var(--green)' : edge >= 5 ? '#7ddfab' : edge > 0 ? 'var(--yellow)' : 'var(--red)';
                            rr.innerHTML = '<span style="font-family:var(--mono);font-size:13px;font-weight:600;color:' + col + '">' + (edge > 0 ? '+' : '') + edge.toFixed(1) + '%</span>'
                                + ' <span style="font-family:var(--mono);font-size:12px;font-weight:600;color:' + (u === 0 ? 'var(--muted2)' : 'var(--green)') + '">' + (u === 0 ? 'PASS' : u + 'u') + '</span>'
                                + (u > 0 ? ' <span style="font-family:var(--mono);font-size:12px;color:var(--text)">' + RAX_ICON + bet.toFixed(0) + '</span>' : '');
                        }
                    });
                    // Update inline side edges for spread
                    document.querySelectorAll('.mc-side-edge[data-id]').forEach(function(el) {
                        var id = el.getAttribute('data-id');
                        if (id && preds[id] !== undefined && preds[id] !== '') updateSideEdge(id);
                    });
                }, 150);
            }
        })
        .catch(function() {});
    }

    // Fetch FanDuel alternate lines for NBA games where Real Sports line differs from main FD line
    // Uses the existing /api/odds_event endpoint (alternate_spreads + alternate_totals)
    // Only fetches for games with mismatches — saves Odds API credits
    // Results stored in altOdds[gid] and picked up by getAltFair / renderTable
    async function fetchAltLinesForNBA() {
        if (currentSport !== 'basketball_nba') return;

        // Single call to FD native API — returns real-time spread, ML, and total for all NBA games
        try {
            var res = await fetch('/api/fd/nbaalts', { credentials: 'same-origin' });
            var data = await res.json();
            if (!data.ok || !data.games) return;

            rawRows.forEach(function(r) {
                if (r.mkt !== 'Spread' && r.mkt !== 'Total' && r.mkt !== 'ML') return;
                if (!r.gid) return;

                // Exact match first, then fuzzy match on last word of each team name
                var game = data.games[r.game];
                if (!game) {
                    var fdTeams = r.game.split(' @ ');
                    var fdAwayLast = (fdTeams[0] || '').trim().split(' ').pop().toLowerCase();
                    var fdHomeLast = (fdTeams[1] || '').trim().split(' ').pop().toLowerCase();
                    var matchedKey = Object.keys(data.games).find(function(k) {
                        var kTeams = k.split(' @ ');
                        var kAwayLast = (kTeams[0] || '').trim().split(' ').pop().toLowerCase();
                        var kHomeLast = (kTeams[1] || '').trim().split(' ').pop().toLowerCase();
                        return kAwayLast === fdAwayLast && kHomeLast === fdHomeLast;
                    });
                    if (matchedKey) game = data.games[matchedKey];
                }
                if (!game) return;

                // Populate altOdds for row visibility + getAltFair fair value calc
                if (r.mkt === 'Spread' || r.mkt === 'Total') altOdds[r.gid] = game;

                // Override displayed values with FD native real-time data
                // For live games DK owns spread/total pts — skip FD overwrite to avoid flicker
                var isLiveRow = r.cm && r.cm <= new Date();
                if (r.mkt === 'Spread' && !isLiveRow) {
                    var sideData = game.spreads && game.spreads[r.side];
                    if (sideData) {
                        var entry = Object.entries(sideData)[0];
                        if (entry) { r.pt = parseFloat(entry[0]); r.am = entry[1]; }
                    }
                } else if (r.mkt === 'Total' && !isLiveRow) {
                    var sideData = game.totals && game.totals[r.side];
                    if (sideData) {
                        var entry = Object.entries(sideData)[0];
                        if (entry) { r.pt = parseFloat(entry[0]); r.am = entry[1]; }
                    }
                } else if (r.mkt === 'ML') {
                    var price = game.ml && game.ml[r.side];
                    if (price != null) r.am = price;
                }
            });

            renderTable();
        } catch(e) {}
    }

    async function fetchAltLinesForWNBA() {
        if (currentSport !== 'basketball_wnba') return;

        try {
            var res = await fetch('/api/fd/wnbaalts', { credentials: 'same-origin' });
            var data = await res.json();
            if (!data.ok || !data.games) return;

            rawRows.forEach(function(r) {
                if (r.mkt !== 'Spread' && r.mkt !== 'Total' && r.mkt !== 'ML') return;
                if (!r.gid) return;

                var game = data.games[r.game];
                if (!game) {
                    var fdTeams = r.game.split(' @ ');
                    var fdAwayLast = (fdTeams[0] || '').trim().split(' ').pop().toLowerCase();
                    var fdHomeLast = (fdTeams[1] || '').trim().split(' ').pop().toLowerCase();
                    var matchedKey = Object.keys(data.games).find(function(k) {
                        var kTeams = k.split(' @ ');
                        var kAwayLast = (kTeams[0] || '').trim().split(' ').pop().toLowerCase();
                        var kHomeLast = (kTeams[1] || '').trim().split(' ').pop().toLowerCase();
                        return kAwayLast === fdAwayLast && kHomeLast === fdHomeLast;
                    });
                    if (matchedKey) game = data.games[matchedKey];
                }
                if (!game) return;

                if (r.mkt === 'Spread' || r.mkt === 'Total') altOdds[r.gid] = game;

                var isLiveRow = r.cm && r.cm <= new Date();
                if (r.mkt === 'Spread' && !isLiveRow) {
                    var sideData = game.spreads && game.spreads[r.side];
                    if (sideData) {
                        var entry = Object.entries(sideData)[0];
                        if (entry) { r.pt = parseFloat(entry[0]); r.am = entry[1]; }
                    }
                } else if (r.mkt === 'Total' && !isLiveRow) {
                    var sideData = game.totals && game.totals[r.side];
                    if (sideData) {
                        var entry = Object.entries(sideData)[0];
                        if (entry) { r.pt = parseFloat(entry[0]); r.am = entry[1]; }
                    }
                } else if (r.mkt === 'ML') {
                    var price = game.ml && game.ml[r.side];
                    if (price != null) r.am = price;
                }
            });

            renderTable();
        } catch(e) {}
    }

    function nativeMlUpdate(rows, games) {
        rows.forEach(function(r) {
            if (r.mkt !== 'ML') return;
            var game = games[r.game];
            if (!game) {
                var fdTeams = r.game.split(' @ ');
                var fdAwayLast = (fdTeams[0] || '').trim().split(' ').pop().toLowerCase();
                var fdHomeLast = (fdTeams[1] || '').trim().split(' ').pop().toLowerCase();
                var matchedKey = Object.keys(games).find(function(k) {
                    var kTeams = k.split(' @ ');
                    var kAwayLast = (kTeams[0] || '').trim().split(' ').pop().toLowerCase();
                    var kHomeLast = (kTeams[1] || '').trim().split(' ').pop().toLowerCase();
                    return kAwayLast === fdAwayLast && kHomeLast === fdHomeLast;
                });
                if (matchedKey) game = games[matchedKey];
            }
            if (!game) return;
            var price = game.ml && game.ml[r.side];
            if (price != null) r.am = price;
        });
    }

    async function fetchMLBNativeUpdate() {
        var sport = currentSport; // capture before any await — prevents race with loadAllEvSports
        if (sport !== 'baseball_mlb') return;
        try {
            var res = await fetch('/api/fd/mlb', { credentials: 'same-origin' });
            var data = await res.json();
            if (!data.ok || !data.games) return;
            // Check if any games in the API response are missing from rawRows
            var existingGames = {};
            rawRows.forEach(function(r) { existingGames[r.game] = true; });
            var hasNewGames = Object.keys(data.games).some(function(g) { return !existingGames[g]; });
            if (hasNewGames) {
                // Rebuild rawRows from scratch to pick up new games, preserving RFI rows
                var rfiRows = rawRows.filter(function(r) { return r.mkt === 'RFI'; });
                var newRows = [];
                Object.entries(data.games).forEach(function([gameKey, game]) {
                    var away = game.away, home = game.home;
                    var cm = game.cm ? new Date(game.cm) : null;
                    var gid = String(game.id);
                    var pid = gid + '-h2h';
                    [[away, 'A'], [home, 'B']].forEach(function(pair) {
                        var teamName = pair[0], ps = pair[1];
                        var price = game.ml[teamName];
                        if (price == null) return;
                        newRows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName, am: price, pt: null, pid: pid, ps: ps, gid: gid });
                    });
                });
                rawRows = newRows.concat(rfiRows);
                rawRowsBySport[sport] = rawRows;
                fetchRealMarkets(sport, true).then(function() { fetchKalshiRFI(); });
            } else {
                nativeMlUpdate(rawRows, data.games);
            }
            renderTable();
        } catch(e) {}
    }

    async function fetchNHLNativeUpdate() {
        if (currentSport !== 'icehockey_nhl') return;
        try {
            var res = await fetch('/api/fd/nhl', { credentials: 'same-origin' });
            var data = await res.json();
            if (!data.ok || !data.games) return;

            rawRows.forEach(function(r) {
                if (r.mkt !== 'Spread' && r.mkt !== 'Total' && r.mkt !== 'ML') return;
                if (!r.gid) return;
                var game = data.games[r.game];
                if (!game) {
                    var fdTeams = r.game.split(' @ ');
                    var fdAwayLast = (fdTeams[0] || '').trim().split(' ').pop().toLowerCase();
                    var fdHomeLast = (fdTeams[1] || '').trim().split(' ').pop().toLowerCase();
                    var matchedKey = Object.keys(data.games).find(function(k) {
                        var kTeams = k.split(' @ ');
                        var kAwayLast = (kTeams[0] || '').trim().split(' ').pop().toLowerCase();
                        var kHomeLast = (kTeams[1] || '').trim().split(' ').pop().toLowerCase();
                        return kAwayLast === fdAwayLast && kHomeLast === fdHomeLast;
                    });
                    if (matchedKey) game = data.games[matchedKey];
                }
                if (!game) return;
                if (r.mkt === 'Spread' || r.mkt === 'Total') altOdds[r.gid] = game;
                if (r.mkt === 'Spread') {
                    var sideData = game.spreads && game.spreads[r.side];
                    if (sideData) { var entry = Object.entries(sideData)[0]; if (entry) { r.pt = parseFloat(entry[0]); r.am = entry[1]; } }
                } else if (r.mkt === 'Total') {
                    var sideData = game.totals && game.totals[r.side];
                    if (sideData) { var entry = Object.entries(sideData)[0]; if (entry) { r.pt = parseFloat(entry[0]); r.am = entry[1]; } }
                } else if (r.mkt === 'ML') {
                    var price = game.ml && game.ml[r.side];
                    if (price != null) r.am = price;
                }
            });

            renderTable();
        } catch(e) {}
    }

    async function fetchFCNativeUpdate() {
        var sport = currentSport; // capture before any await — prevents race with loadAllEvSports
        if (sport !== 'soccer_fc') return;
        try {
            var res = await fetch('/api/fd/fc', { credentials: 'same-origin' });
            if (!fcPoller) return; // loadOdds() cleared the poller while we were fetching — bail out to avoid stale flash
            var data = await res.json();
            if (!data.ok || !data.games) return;
            // Check if any new games appeared (match started, new fixture added)
            var existingGames = {};
            rawRows.forEach(function(r) { existingGames[r.game] = true; });
            var hasNewGames = Object.keys(data.games).some(function(g) { return !existingGames[g]; });
            if (hasNewGames) {
                var rows = [];
                Object.entries(data.games).forEach(function([gameKey, game]) {
                    var away = game.away, home = game.home;
                    var cm = game.cm ? new Date(game.cm) : null;
                    var gid = String(game.id);
                    var pid = gid + '-h2h';
                    // Determine correct ±0.5 pairing using DK prices.
                    // Lower American odds for the -0.5 line = more likely to win = DK's -0.5 team.
                    var awayGetsMinus;
                    if (game.awm != null && game.hm != null) {
                        awayGetsMinus = game.awm <= game.hm;
                    } else if (game.awm != null) { awayGetsMinus = true; }
                    else { awayGetsMinus = false; }
                    [[away, 'A'], [home, 'B']].forEach(function(pair) {
                        var teamName = pair[0], ps = pair[1];
                        var isAway = ps === 'A';
                        var isMinus = isAway ? awayGetsMinus : !awayGetsMinus;
                        var initAm = isMinus ? (isAway ? game.awm : game.hm) : (isAway ? game.awp : game.hp);
                        var initPt = isMinus ? -0.5 : 0.5;
                        if (initAm == null) return;
                        rows.push({ id: pid + '-' + ps, game: gameKey, cm: cm, mkt: 'Spread', side: teamName,
                            am: initAm, pt: initPt, pid: pid, ps: ps, gid: gid, league: game.league || '',
                            _sport_key: 'soccer_fc', _dkHm: game.hm, _dkHp: game.hp, _dkAwm: game.awm, _dkAwp: game.awp });
                    });
                });
                rawRows = rows;
                rawRowsBySport[sport] = rawRows;
                fetchRealMarkets(sport, true);
            } else {
                // FC: update stored DK prices and re-apply the RS line
                rawRows.forEach(function(r) {
                    if (r.mkt !== 'Spread') return;
                    var game = data.games[r.game];
                    if (!game) return;
                    r._dkSpreads = game.spreads || { Home: {}, Away: {} };
                    // Re-apply current RS line to pick the updated DK price at that exact line
                    var yl = yourLines[r.id];
                    if (yl != null) {
                        var fcOutType4 = r.ps === 'B' ? 'Home' : 'Away';
                        var dk = (r._dkSpreads[fcOutType4] || {})[String(yl)];
                        if (dk != null) { r.am = dk; r.pt = yl; }
                    }
                    if (game.league) r.league = game.league;
                });
                rawRowsBySport[sport] = rawRows;
            }
            // Update status bar timestamp so users can see odds are live
            var nowStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
            var stxtEl = document.getElementById('status-txt');
            var dotEl = document.getElementById('sdot');
            if (stxtEl) stxtEl.textContent = 'Updated ' + nowStr + ' - ' + Object.keys(data.games).length + ' games - DraftKings';
            if (dotEl) dotEl.className = 'sdot live';
            renderTable();
        } catch(e) {}
    }

    async function fetchWCNativeUpdate() {
        var sport = currentSport;
        if (sport !== 'soccer_wc') return;
        try {
            var res = await fetch('/api/fd/wc', { credentials: 'same-origin' });
            if (!wcPoller) return;
            var data = await res.json();
            if (!data.ok || !data.games) return;
            var existingGames = {};
            rawRows.forEach(function(r) { existingGames[r.game] = true; });
            var hasNewGames = Object.keys(data.games).some(function(g) { return !existingGames[g]; });
            if (hasNewGames) {
                var rows = [];
                Object.entries(data.games).forEach(function([gameKey, game]) {
                    var away = game.away, home = game.home;
                    var cm = game.cm ? new Date(game.cm) : null;
                    var gid = String(game.id);
                    var pid = gid + '-ta';
                    [[away, 'A', game.away_ml], [home, 'B', game.home_ml]].forEach(function(triple) {
                        var teamName = triple[0], ps = triple[1], am = triple[2];
                        if (am == null) return;
                        rows.push({ id: pid+'-'+ps, game: gameKey, cm: cm, mkt: 'ML', side: teamName,
                            am: am, pt: null, pid: pid, ps: ps, gid: gid, league: game.league || '',
                            _sport_key: 'soccer_wc' });
                    });
                });
                rawRows = rows;
                rawRowsBySport[sport] = rawRows;
                fetchRealMarkets(sport, true);
            } else {
                // Update ML odds for existing rows
                rawRows.forEach(function(r) {
                    if (r.mkt !== 'ML') return;
                    var game = data.games[r.game];
                    if (!game) return;
                    var newAm = r.ps === 'A' ? game.away_ml : game.home_ml;
                    if (newAm != null) r.am = newAm;
                    if (game.league) r.league = game.league;
                });
                rawRowsBySport[sport] = rawRows;
            }
            var nowStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
            var stxtEl = document.getElementById('status-txt');
            var dotEl = document.getElementById('sdot');
            if (stxtEl) stxtEl.textContent = 'Updated ' + nowStr + ' - ' + Object.keys(data.games).length + ' games - DraftKings';
            if (dotEl) dotEl.className = 'sdot live';
            renderTable();
        } catch(e) {}
    }

    async function fetchDKAltLines() {
        if (currentSport !== 'basketball_nba') return;
        try {
            var res = await fetch('/api/dk/nbaalts', { credentials: 'same-origin' });
            var data = await res.json();
            if (!data.ok || !data.games) return;

            // Helper: find DK game for a rawRow game key (exact then fuzzy last-word match)
            function findDkGame(gameKey) {
                if (data.games[gameKey]) return data.games[gameKey];
                var fdTeams = gameKey.split(' @ ');
                var fdAwayLast = (fdTeams[0] || '').trim().split(' ').pop().toLowerCase();
                var fdHomeLast = (fdTeams[1] || '').trim().split(' ').pop().toLowerCase();
                var matchedKey = Object.keys(data.games).find(function(k) {
                    var kTeams = k.split(' @ ');
                    var kAwayLast = (kTeams[0] || '').trim().split(' ').pop().toLowerCase();
                    var kHomeLast = (kTeams[1] || '').trim().split(' ').pop().toLowerCase();
                    return kAwayLast === fdAwayLast && kHomeLast === fdHomeLast;
                });
                return matchedKey ? data.games[matchedKey] : null;
            }

            var nowDate = new Date();

            // First pass: populate dkAltOdds, cache pre-game data, update existing live rows
            rawRows.forEach(function(r) {
                if (!r.gid) return;
                if (r.mkt !== 'Spread' && r.mkt !== 'Total' && r.mkt !== 'ML') return;
                var dk = findDkGame(r.game);
                if (!dk) return;

                dkAltOdds[r.gid] = dk;

                // Cache whenever DK actually has alt line data (may be pre-game or live)
                var hasSpread = Object.keys(dk.spreads['Away'] || {}).length > 0;
                var hasTotal  = Object.keys(dk.totals['Over']  || {}).length > 0;
                if (hasSpread || hasTotal) dkPreGameStore[r.gid] = dk;

                // Update existing Spread/Total rows for live games with best DK alt odds
                if ((r.mkt === 'Spread' || r.mkt === 'Total') && r.cm && r.cm <= nowDate) {
                    var dkSrc = (hasSpread || hasTotal) ? dk : dkPreGameStore[r.gid];
                    if (!dkSrc) return;
                    if (r.mkt === 'Spread') {
                        var sideKey = r.ps === 'A' ? 'Away' : 'Home';
                        var entries = Object.entries(dkSrc.spreads[sideKey] || {});
                        if (entries.length) {
                            var yl = yourLines[r.id];
                            if (yl == null) {
                                // Real Sports line not set yet — pick closest to 0 temporarily
                                var best = entries.reduce(function(a, b) { return Math.abs(parseFloat(a[0])) <= Math.abs(parseFloat(b[0])) ? a : b; });
                                r.am = best[1]; r.pt = parseFloat(best[0]);
                            } else {
                                var ylPt = parseFloat(yl);
                                if (Math.abs(parseFloat(r.pt) - ylPt) <= 0.001) {
                                    // FD line already equals Real Sports line — update DK price for that point if available
                                    var exact = entries.find(function(e) { return Math.abs(parseFloat(e[0]) - ylPt) <= 0.001; });
                                    if (exact) r.am = exact[1];
                                } else {
                                    // FD line differs — use exact DK match at Real Sports line
                                    var exact = entries.find(function(e) { return Math.abs(parseFloat(e[0]) - ylPt) <= 0.001; });
                                    if (exact) { r.am = exact[1]; r.pt = ylPt; }
                                    // No exact match: leave r.pt as is — renderTable will hide the row
                                }
                            }
                        }
                    } else {
                        var entries = Object.entries(dkSrc.totals[r.side] || {});
                        if (entries.length) {
                            var yl = yourLines[r.id];
                            if (yl == null) {
                                var best = entries.reduce(function(a, b) { return Math.abs(parseFloat(a[0])) <= Math.abs(parseFloat(b[0])) ? a : b; });
                                r.am = best[1]; r.pt = parseFloat(best[0]);
                            } else {
                                var ylPt = parseFloat(yl);
                                var exact = entries.find(function(e) { return Math.abs(parseFloat(e[0]) - ylPt) <= 0.001; });
                                if (exact) { r.am = exact[1]; r.pt = ylPt; }
                                // No exact match: leave r.pt as is — renderTable will hide the row
                            }
                        }
                    }
                }
            });

            // Second pass: synthesize spread/total rows for live games where FD has suspended them
            var existingPids = {};
            rawRows.forEach(function(r) { existingPids[r.pid] = true; });
            var newRows = [];
            rawRows.forEach(function(r) {
                if (r.mkt !== 'ML' || !r.gid || !r.cm) return;
                if (r.cm > nowDate) return; // only live games
                var dk = findDkGame(r.game);
                if (dk) dkAltOdds[r.gid] = dk;

                // Use current DK data if available, otherwise fall back to cached pre-game data
                var hasCurrentData = dk && Object.keys(dk.spreads['Away'] || {}).length > 0;
                var dkSrc = hasCurrentData ? dk : dkPreGameStore[r.gid];
                if (!dkSrc) return;

                var spreadPid = r.gid + '-spreads';
                var totalPid  = r.gid + '-totals';
                var gameParts = r.game.split(' @ ');
                var away = gameParts[0] || '', home = gameParts[1] || '';

                if (!existingPids[spreadPid]) {
                    var awayEntries = Object.entries(dkSrc.spreads['Away'] || {});
                    var homeEntries = Object.entries(dkSrc.spreads['Home'] || {});
                    if (awayEntries.length && homeEntries.length) {
                        var awayE = awayEntries.reduce(function(a, b) { return Math.abs(parseFloat(a[0])) <= Math.abs(parseFloat(b[0])) ? a : b; });
                        var homeE = homeEntries.reduce(function(a, b) { return Math.abs(parseFloat(a[0])) <= Math.abs(parseFloat(b[0])) ? a : b; });
                        newRows.push({ id: spreadPid + '-A', game: r.game, cm: r.cm, mkt: 'Spread', side: away, am: awayE[1], pt: parseFloat(awayE[0]), pid: spreadPid, ps: 'A', gid: r.gid });
                        newRows.push({ id: spreadPid + '-B', game: r.game, cm: r.cm, mkt: 'Spread', side: home, am: homeE[1], pt: parseFloat(homeE[0]), pid: spreadPid, ps: 'B', gid: r.gid });
                        existingPids[spreadPid] = true;
                    }
                }
                if (!existingPids[totalPid]) {
                    var overEntries  = Object.entries(dkSrc.totals['Over']  || {});
                    var underEntries = Object.entries(dkSrc.totals['Under'] || {});
                    if (overEntries.length && underEntries.length) {
                        var overE  = overEntries.reduce(function(a, b) { return Math.abs(parseFloat(a[0])) <= Math.abs(parseFloat(b[0])) ? a : b; });
                        var underE = underEntries.reduce(function(a, b) { return Math.abs(parseFloat(a[0])) <= Math.abs(parseFloat(b[0])) ? a : b; });
                        newRows.push({ id: totalPid + '-A', game: r.game, cm: r.cm, mkt: 'Total', side: 'Over',  am: overE[1],  pt: parseFloat(overE[0]),  pid: totalPid, ps: 'A', gid: r.gid });
                        newRows.push({ id: totalPid + '-B', game: r.game, cm: r.cm, mkt: 'Total', side: 'Under', am: underE[1], pt: parseFloat(underE[0]), pid: totalPid, ps: 'B', gid: r.gid });
                        existingPids[totalPid] = true;
                    }
                }
            });

            if (newRows.length) {
                rawRows = rawRows.concat(newRows);
                rawRowsBySport[currentSport] = rawRows;
                var syncD = lastSyncData[currentSport];
                if (syncD) fillPredsFromSync(newRows, syncD);
                // Re-pick DK alt line closest to Real Sports line now that yourLines is populated
                newRows.forEach(function(nr) {
                    if (yourLines[nr.id] == null) return;
                    var dk = findDkGame(nr.game);
                    var hasCurrentDk = dk && Object.keys((dk.spreads && dk.spreads['Away']) || {}).length > 0;
                    var dkSrc = hasCurrentDk ? dk : dkPreGameStore[nr.gid];
                    if (!dkSrc) return;
                    var yl = parseFloat(yourLines[nr.id]);
                    if (nr.mkt === 'Spread') {
                        var sideKey = nr.ps === 'A' ? 'Away' : 'Home';
                        var entries = Object.entries(dkSrc.spreads[sideKey] || {});
                        var exact = entries.find(function(e) { return Math.abs(parseFloat(e[0]) - yl) <= 0.001; });
                        if (exact) { nr.am = exact[1]; nr.pt = yl; }
                        // No exact match: nr.pt stays at initial value — renderTable will hide the row
                    } else if (nr.mkt === 'Total') {
                        var entries = Object.entries(dkSrc.totals[nr.side] || {});
                        var exact = entries.find(function(e) { return Math.abs(parseFloat(e[0]) - yl) <= 0.001; });
                        if (exact) { nr.am = exact[1]; nr.pt = yl; }
                    }
                });
            }

            renderTable();
        } catch(e) {}
    }

    async function fetchDKAltLinesNHL() {
        if (currentSport !== 'icehockey_nhl') return;
        try {
            var res = await fetch('/api/dk/nhalalts', { credentials: 'same-origin' });
            var data = await res.json();
            if (!data.ok || !data.games) return;

            function findDkGame(gameKey) {
                if (data.games[gameKey]) return data.games[gameKey];
                var fdTeams = gameKey.split(' @ ');
                var fdAwayLast = (fdTeams[0] || '').trim().split(' ').pop().toLowerCase();
                var fdHomeLast = (fdTeams[1] || '').trim().split(' ').pop().toLowerCase();
                var matchedKey = Object.keys(data.games).find(function(k) {
                    var kTeams = k.split(' @ ');
                    var kAwayLast = (kTeams[0] || '').trim().split(' ').pop().toLowerCase();
                    var kHomeLast = (kTeams[1] || '').trim().split(' ').pop().toLowerCase();
                    return kAwayLast === fdAwayLast && kHomeLast === fdHomeLast;
                });
                return matchedKey ? data.games[matchedKey] : null;
            }

            var nowDate = new Date();

            // First pass: populate dkAltOdds, cache pre-game data, update existing live rows
            rawRows.forEach(function(r) {
                if (!r.gid) return;
                if (r.mkt !== 'Spread' && r.mkt !== 'Total' && r.mkt !== 'ML') return;
                var dk = findDkGame(r.game);
                if (!dk) return;

                dkAltOdds[r.gid] = dk;

                var hasSpread = Object.keys(dk.spreads['Away'] || {}).length > 0;
                var hasTotal  = Object.keys(dk.totals['Over']  || {}).length > 0;
                if (hasSpread || hasTotal) dkPreGameStore[r.gid] = dk;
            });

            // Second pass: synthesize spread/total rows for live games where FD has suspended them
            var existingPids = {};
            rawRows.forEach(function(r) { existingPids[r.pid] = true; });
            var newRows = [];
            rawRows.forEach(function(r) {
                if (r.mkt !== 'ML' || !r.gid || !r.cm) return;
                if (r.cm > nowDate) return;
                var dk = findDkGame(r.game);
                if (dk) dkAltOdds[r.gid] = dk;

                var hasCurrentData = dk && Object.keys(dk.spreads['Away'] || {}).length > 0;
                var dkSrc = hasCurrentData ? dk : dkPreGameStore[r.gid];
                if (!dkSrc) return;

                var spreadPid = r.gid + '-spreads';
                var totalPid  = r.gid + '-totals';
                var gameParts = r.game.split(' @ ');
                var away = gameParts[0] || '', home = gameParts[1] || '';

                if (!existingPids[spreadPid]) {
                    var awayEntries = Object.entries(dkSrc.spreads['Away'] || {});
                    var homeEntries = Object.entries(dkSrc.spreads['Home'] || {});
                    if (awayEntries.length && homeEntries.length) {
                        var awayE = awayEntries.reduce(function(a, b) { return Math.abs(parseFloat(a[0])) <= Math.abs(parseFloat(b[0])) ? a : b; });
                        var homeE = homeEntries.reduce(function(a, b) { return Math.abs(parseFloat(a[0])) <= Math.abs(parseFloat(b[0])) ? a : b; });
                        newRows.push({ id: spreadPid+'-A', game: r.game, cm: r.cm, mkt: 'Spread', side: away, am: awayE[1], pt: parseFloat(awayE[0]), pid: spreadPid, ps: 'A', gid: r.gid });
                        newRows.push({ id: spreadPid+'-B', game: r.game, cm: r.cm, mkt: 'Spread', side: home, am: homeE[1], pt: parseFloat(homeE[0]), pid: spreadPid, ps: 'B', gid: r.gid });
                        existingPids[spreadPid] = true;
                    }
                }
                if (!existingPids[totalPid]) {
                    var overEntries  = Object.entries(dkSrc.totals['Over']  || {});
                    var underEntries = Object.entries(dkSrc.totals['Under'] || {});
                    if (overEntries.length && underEntries.length) {
                        var overE  = overEntries.reduce(function(a, b) { return Math.abs(parseFloat(a[0])) <= Math.abs(parseFloat(b[0])) ? a : b; });
                        var underE = underEntries.reduce(function(a, b) { return Math.abs(parseFloat(a[0])) <= Math.abs(parseFloat(b[0])) ? a : b; });
                        newRows.push({ id: totalPid+'-A', game: r.game, cm: r.cm, mkt: 'Total', side: 'Over',  am: overE[1],  pt: parseFloat(overE[0]),  pid: totalPid, ps: 'A', gid: r.gid });
                        newRows.push({ id: totalPid+'-B', game: r.game, cm: r.cm, mkt: 'Total', side: 'Under', am: underE[1], pt: parseFloat(underE[0]), pid: totalPid, ps: 'B', gid: r.gid });
                        existingPids[totalPid] = true;
                    }
                }
            });

            if (newRows.length) {
                rawRows = rawRows.concat(newRows);
                rawRowsBySport[currentSport] = rawRows;
                var syncD = lastSyncData[currentSport];
                if (syncD) fillPredsFromSync(newRows, syncD);
                newRows.forEach(function(nr) {
                    if (yourLines[nr.id] == null) return;
                    var dk = findDkGame(nr.game);
                    var hasCurrentDk = dk && Object.keys((dk.spreads && dk.spreads['Away']) || {}).length > 0;
                    var dkSrc = hasCurrentDk ? dk : dkPreGameStore[nr.gid];
                    if (!dkSrc) return;
                    var yl = parseFloat(yourLines[nr.id]);
                    if (nr.mkt === 'Spread') {
                        var sideKey = nr.ps === 'A' ? 'Away' : 'Home';
                        var entries = Object.entries(dkSrc.spreads[sideKey] || {});
                        var exact = entries.find(function(e) { return Math.abs(parseFloat(e[0]) - yl) <= 0.001; });
                        if (exact) { nr.am = exact[1]; nr.pt = yl; }
                    } else if (nr.mkt === 'Total') {
                        var entries = Object.entries(dkSrc.totals[nr.side] || {});
                        var exact = entries.find(function(e) { return Math.abs(parseFloat(e[0]) - yl) <= 0.001; });
                        if (exact) { nr.am = exact[1]; nr.pt = yl; }
                    }
                });
            }

            renderTable();
        } catch(e) {}
    }

    handleCheckoutReturn();
    initTheme();
    initStickyHeader();
    checkSession();

    // Keyboard shortcuts (only when dashboard is visible and focus is not in an input)
    document.addEventListener('keydown', function(e) {
        if (!document.getElementById('dashboard') || document.getElementById('dashboard').style.display === 'none') return;
        var tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        // R — refresh
        if (e.key === 'r' || e.key === 'R') {
            var rb = document.getElementById('refresh-btn');
            if (rb && !rb.disabled && rb.style.display !== 'none') { e.preventDefault(); loadOdds(); }
        }
        // 1–7 — switch sport tabs
        var num = parseInt(e.key, 10);
        if (num >= 1 && num <= 7) {
            var tabs = document.querySelectorAll('#sport-tabs .sport-tab');
            if (tabs[num - 1]) { e.preventDefault(); tabs[num - 1].click(); }
        }
    });
    // Restore exclusive bets button state
    (function() {
        ['excl-bets-btn', 'ev-one-side-btn'].forEach(function(btnId) {
            var btn = document.getElementById(btnId);
            if (btn && exclusiveBets) {
                btn.style.background = 'var(--accent)';
                btn.style.color = '#fff';
                btn.style.borderColor = 'var(--accent)';
            }
        });
    })();

    // ── GROUP JOIN BANNER ──
    (function() {
        var BANNER_KEY = 'raxedge_group_banner_dismissed';
        if (localStorage.getItem(BANNER_KEY)) return;
        var banner = document.createElement('div');
        banner.id = 'group-banner';
        banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:linear-gradient(90deg,#1a1a2e 0%,#16213e 100%);border-top:1px solid rgba(79,110,247,0.35);padding:13px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 -4px 24px rgba(0,0,0,0.4)';
        banner.innerHTML = ''
            + '<div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">'
            +   '<div style="width:8px;height:8px;border-radius:50%;background:var(--accent);flex-shrink:0;animation:pulse 2s ease-in-out infinite"></div>'
            +   '<span style="font-family:var(--sans);font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Join the RaxEdge group for updates, edges &amp; community!</span>'
            + '</div>'
            + '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">'
            +   '<a href="https://www.realapp.com/nlvcQFNFg4k" target="_blank" rel="noopener" style="background:var(--accent);color:#fff;font-family:var(--sans);font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:7px 16px;border-radius:5px;text-decoration:none;white-space:nowrap">Join Group</a>'
            +   '<button onclick="(function(){localStorage.setItem(\'raxedge_group_banner_dismissed\',\'1\');document.getElementById(\'group-banner\').style.display=\'none\';})()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;line-height:1;padding:2px 4px" aria-label="Dismiss">&times;</button>'
            + '</div>';
        document.body.appendChild(banner);
    })();
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(function() {});
    }
