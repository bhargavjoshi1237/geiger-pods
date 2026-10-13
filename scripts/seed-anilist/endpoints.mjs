// AniList REST façade for the Geiger Pods showcase. Each endpoint is a REST
// resource + GET method whose HTTP integration POSTs a GraphQL query to
// AniList (https://graphql.anilist.co). The request template builds the
// GraphQL body from path/query params; the response template flattens
// AniList's `data.*` envelope into a clean, documented JSON shape.

export const ANILIST_URL = "https://graphql.anilist.co";

const MEDIA_CARD = "id title { romaji english native } format status episodes chapters averageScore popularity genres coverImage { large color } siteUrl";

/** Request template: GraphQL body with variables pulled from the request. */
function gql(query, variables) {
  const vars = Object.entries(variables)
    .map(([name, expr]) => `"${name}": ${expr}`)
    .join(", ");
  return `{"query": "${query.replace(/"/g, '\\"')}", "variables": {${vars}}}`;
}

/** Integer path/query param with a default (template expression). */
const intParam = (name, fallback) =>
  `#if($input.params('${name}').matches("^[0-9]+$"))$input.params('${name}')#else ${fallback}#end`;
// $util.escapeJavaScript escapes ' as \' (JavaScript, not JSON), so undo that
// one escape: the VTL regex [\\]' matches a backslash followed by a quote.
const UNQUOTE = `.replaceAll("[${"\\".repeat(4)}]'", "'")`;

/** JSON string literal from a template reference (null → ""). */
const esc = (ref) => `"$util.escapeJavaScript(${ref})${UNQUOTE}"`;
const strParam = (name) => esc(`$input.params('${name}')`);

/** Numeric field that may be null on AniList (renders a JSON number or null). */
const num = (ref) => `#if($${ref})$${ref}#else null#end`;

/** JSON value of `field` on the current #foreach item of the list at `listPath`. */
const jsonAt = (listPath, field) => `$input.json("${listPath}[\${foreach.index}].${field}")`;

/** Response template: maps a list of media cards. */
function mediaList(path) {
  return [
    `#set($items = $input.path('${path}'))`,
    `{"count": #if($items)$items.size()#else 0#end, "results": [`,
    `#foreach($m in $items){"id": $m.id, "title": ${jsonAt(path, "title.english")}, "romaji": ${jsonAt(path, "title.romaji")}, "format": "$!{m.format}", "score": ${num("m.averageScore")}, "popularity": ${num("m.popularity")}, "cover": "$!{m.coverImage.large}", "url": "$!{m.siteUrl}"}#if($foreach.hasNext),#end`,
    `#end`,
    `], "source": "AniList via Geiger Pods"}`,
  ].join("\n");
}

export const ENDPOINTS = [
  {
    path: "/anime/{id}",
    operationName: "GetAnime",
    summary: "Fetch one anime by AniList id",
    cacheKey: ["method.request.path.id"],
    pathParams: ["id"],
    query: `query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_CARD} description(asHtml: false) season seasonYear duration studios(isMain: true) { nodes { id name } } nextAiringEpisode { episode airingAt } trailer { site id } } }`,
    variables: { id: intParam("id", 0) },
    response: [
      `#set($m = $input.path('$.data.Media'))`,
      `{"id": $m.id, "title": $input.json('$.data.Media.title'), "format": "$!{m.format}", "status": "$!{m.status}",`,
      ` "season": "$!{m.season} $!{m.seasonYear}", "episodes": $input.json('$.data.Media.episodes'), "durationMinutes": $input.json('$.data.Media.duration'),`,
      ` "score": $input.json('$.data.Media.averageScore'), "popularity": $m.popularity, "genres": $input.json('$.data.Media.genres'),`,
      ` "studios": $input.json('$.data.Media.studios.nodes'), "nextEpisode": $input.json('$.data.Media.nextAiringEpisode'),`,
      ` "cover": "$!{m.coverImage.large}", "accentColor": "$!{m.coverImage.color}", "url": "$!{m.siteUrl}",`,
      ` "synopsis": $input.json('$.data.Media.description'), "source": "AniList via Geiger Pods"}`,
    ].join("\n"),
    sample: { pathParams: { id: "154587" } },
  },
  {
    path: "/anime/search",
    operationName: "SearchAnime",
    summary: "Search anime by title, optionally filtered by genre",
    queryParams: { q: true, page: false, perPage: false, genre: false },
    cacheKey: ["method.request.querystring.q", "method.request.querystring.page", "method.request.querystring.genre"],
    query: `query ($q: String, $page: Int, $perPage: Int, $genre: String) { Page(page: $page, perPage: $perPage) { pageInfo { total currentPage hasNextPage } media(search: $q, genre: $genre, type: ANIME, sort: SEARCH_MATCH) { ${MEDIA_CARD} } } }`,
    variables: {
      q: strParam("q"),
      page: intParam("page", 1),
      perPage: `#if($input.params('perPage').matches("^[0-9]+$"))$input.params('perPage')#else $stageVariables.defaultPerPage#end`,
      genre: `#if($input.params('genre') != "")${strParam("genre")}#else null#end`,
    },
    response: mediaList("$.data.Page.media"),
    sample: { querystring: { q: "Frieren" } },
  },
  {
    path: "/anime/trending",
    operationName: "TrendingAnime",
    summary: "What the AniList community is watching right now",
    queryParams: { perPage: false },
    cacheKey: ["method.request.querystring.perPage"],
    query: `query ($perPage: Int) { Page(perPage: $perPage) { media(type: ANIME, sort: TRENDING_DESC) { ${MEDIA_CARD} } } }`,
    variables: { perPage: intParam("perPage", 10) },
    response: mediaList("$.data.Page.media"),
    sample: {},
  },
  {
    path: "/anime/seasonal/{year}/{season}",
    operationName: "SeasonalAnime",
    summary: "Anime airing in a given season (WINTER, SPRING, SUMMER, FALL)",
    pathParams: ["year", "season"],
    cacheKey: ["method.request.path.year", "method.request.path.season"],
    query: `query ($year: Int, $season: MediaSeason) { Page(perPage: 20) { media(seasonYear: $year, season: $season, type: ANIME, sort: POPULARITY_DESC) { ${MEDIA_CARD} } } }`,
    variables: { year: intParam("year", 2026), season: `"$input.params('season').toUpperCase()"` },
    response: mediaList("$.data.Page.media"),
    sample: { pathParams: { year: "2026", season: "fall" } },
  },
  {
    path: "/anime/{id}/characters",
    operationName: "AnimeCharacters",
    summary: "Main and supporting cast with Japanese voice actors",
    pathParams: ["id"],
    cacheKey: ["method.request.path.id"],
    query: `query ($id: Int) { Media(id: $id, type: ANIME) { id title { romaji } characters(sort: ROLE, perPage: 12) { edges { role node { id name { full native } image { medium } } voiceActors(language: JAPANESE) { id name { full } } } } } }`,
    variables: { id: intParam("id", 0) },
    response: [
      `#set($edges = $input.path('$.data.Media.characters.edges'))`,
      `{"animeId": $input.json('$.data.Media.id'), "anime": $input.json('$.data.Media.title.romaji'), "cast": [`,
      `#foreach($e in $edges){"id": $e.node.id, "name": ${jsonAt("$.data.Media.characters.edges", "node.name.full")}, "native": ${jsonAt("$.data.Media.characters.edges", "node.name.native")}, "role": "$e.role", "image": "$!{e.node.image.medium}"#if($e.voiceActors.size() > 0), "voiceActor": ${jsonAt("$.data.Media.characters.edges", "voiceActors[0].name.full")}#end}#if($foreach.hasNext),#end`,
      `#end`,
      `]}`,
    ].join("\n"),
    sample: { pathParams: { id: "154587" } },
  },
  {
    path: "/anime/{id}/recommendations",
    operationName: "AnimeRecommendations",
    summary: "Community recommendations for fans of this anime",
    pathParams: ["id"],
    cacheKey: ["method.request.path.id"],
    query: `query ($id: Int) { Media(id: $id, type: ANIME) { recommendations(sort: RATING_DESC, perPage: 8) { nodes { rating mediaRecommendation { ${MEDIA_CARD} } } } } }`,
    variables: { id: intParam("id", 0) },
    response: [
      `#set($nodes = $input.path('$.data.Media.recommendations.nodes'))`,
      `{"recommendations": [`,
      `#foreach($n in $nodes)#set($m = $n.mediaRecommendation){"votes": $n.rating, "id": $m.id, "title": ${jsonAt("$.data.Media.recommendations.nodes", "mediaRecommendation.title.romaji")}, "score": ${num("m.averageScore")}, "url": "$!{m.siteUrl}"}#if($foreach.hasNext),#end`,
      `#end`,
      `]}`,
    ].join("\n"),
    sample: { pathParams: { id: "154587" } },
  },
  {
    path: "/manga/{id}",
    operationName: "GetManga",
    summary: "Fetch one manga by AniList id",
    pathParams: ["id"],
    cacheKey: ["method.request.path.id"],
    query: `query ($id: Int) { Media(id: $id, type: MANGA) { ${MEDIA_CARD} volumes staff(perPage: 3) { nodes { id name { full } } } } }`,
    variables: { id: intParam("id", 0) },
    response: [
      `#set($m = $input.path('$.data.Media'))`,
      `{"id": $m.id, "title": $input.json('$.data.Media.title'), "format": "$!{m.format}", "status": "$!{m.status}", "chapters": $input.json('$.data.Media.chapters'),`,
      ` "volumes": $input.json('$.data.Media.volumes'), "score": $input.json('$.data.Media.averageScore'), "genres": $input.json('$.data.Media.genres'),`,
      ` "authors": $input.json('$.data.Media.staff.nodes'), "cover": "$!{m.coverImage.large}", "url": "$!{m.siteUrl}", "source": "AniList via Geiger Pods"}`,
    ].join("\n"),
    sample: { pathParams: { id: "30013" } },
  },
  {
    path: "/manga/search",
    operationName: "SearchManga",
    summary: "Search manga and light novels by title",
    queryParams: { q: true },
    cacheKey: ["method.request.querystring.q"],
    query: `query ($q: String) { Page(perPage: 10) { media(search: $q, type: MANGA, sort: SEARCH_MATCH) { ${MEDIA_CARD} } } }`,
    variables: { q: strParam("q") },
    response: mediaList("$.data.Page.media"),
    sample: { querystring: { q: "Berserk" } },
  },
  {
    path: "/characters/{id}",
    operationName: "GetCharacter",
    summary: "Character profile with the shows they appear in",
    pathParams: ["id"],
    cacheKey: ["method.request.path.id"],
    query: `query ($id: Int) { Character(id: $id) { id name { full native alternative } image { large } gender age favourites siteUrl media(perPage: 5, sort: POPULARITY_DESC) { nodes { id title { romaji } type } } } }`,
    variables: { id: intParam("id", 0) },
    response: [
      `#set($c = $input.path('$.data.Character'))`,
      `{"id": $c.id, "name": $input.json('$.data.Character.name'), "gender": "$!{c.gender}", "age": "$!{c.age}", "favourites": $c.favourites,`,
      ` "image": "$!{c.image.large}", "appearsIn": $input.json('$.data.Character.media.nodes'), "url": "$!{c.siteUrl}"}`,
    ].join("\n"),
    sample: { pathParams: { id: "40" } },
  },
  {
    path: "/staff/{id}",
    operationName: "GetStaff",
    summary: "Voice actor / creator profile",
    pathParams: ["id"],
    cacheKey: ["method.request.path.id"],
    query: `query ($id: Int) { Staff(id: $id) { id name { full native } primaryOccupations homeTown favourites image { large } siteUrl } }`,
    variables: { id: intParam("id", 0) },
    response: `{"staff": $input.json('$.data.Staff'), "source": "AniList via Geiger Pods"}`,
    sample: { pathParams: { id: "95185" } },
  },
  {
    path: "/studios/{id}",
    operationName: "GetStudio",
    summary: "Animation studio and its most popular productions",
    pathParams: ["id"],
    cacheKey: ["method.request.path.id"],
    query: `query ($id: Int) { Studio(id: $id) { id name isAnimationStudio favourites siteUrl media(sort: POPULARITY_DESC, perPage: 8, isMain: true) { nodes { ${MEDIA_CARD} } } } }`,
    variables: { id: intParam("id", 0) },
    response: [
      `{"id": $input.json('$.data.Studio.id'), "name": $input.json('$.data.Studio.name'), "favourites": $input.json('$.data.Studio.favourites'),`,
      `"url": $input.json('$.data.Studio.siteUrl'), "works": $input.json('$.data.Studio.media.nodes')}`,
    ].join("\n"),
    sample: { pathParams: { id: "11" } },
  },
  {
    path: "/users/{name}",
    operationName: "GetUserProfile",
    summary: "Public AniList profile and watch statistics",
    pathParams: ["name"],
    cacheKey: ["method.request.path.name"],
    query: `query ($name: String) { User(name: $name) { id name avatar { large } siteUrl statistics { anime { count episodesWatched minutesWatched meanScore genres(limit: 5, sort: COUNT_DESC) { genre count } } manga { count chaptersRead } } } }`,
    variables: { name: strParam("name") },
    response: `{"user": $input.json('$.data.User.name'), "avatar": $input.json('$.data.User.avatar.large'), "url": $input.json('$.data.User.siteUrl'), "stats": $input.json('$.data.User.statistics')}`,
    sample: { pathParams: { name: "7elou" } },
  },
  {
    path: "/schedule/airing",
    operationName: "AiringSchedule",
    summary: "The next episodes to air, soonest first",
    queryParams: { perPage: false },
    cacheKey: [],
    query: `query { Page(perPage: 25) { airingSchedules(notYetAired: true, sort: TIME) { episode airingAt timeUntilAiring media { id title { romaji english } coverImage { medium } } } } }`,
    variables: {},
    response: `{"airing": $input.json('$.data.Page.airingSchedules'), "note": "next 25 episodes to air"}`,
    sample: {},
  },
].map((endpoint) => ({
  ...endpoint,
  requestTemplate: gql(endpoint.query, endpoint.variables),
}));
