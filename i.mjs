import { customAlphabet } from "nanoid";
import ISO6391 from "iso-639-1";
import CryptoJS from "crypto-js";
import * as unpacker from "unpacker";
import { unpack } from "unpacker";
import { load } from "cheerio";
import FormData from "form-data";
import cookie from "cookie";
import setCookieParser from "set-cookie-parser";
class NotFoundError extends Error {
  constructor(reason) {
    super(`Couldn't find a stream: ${reason ?? "not found"}`);
    this.name = "NotFoundError";
  }
}
function formatSourceMeta(v) {
  const types = [];
  if (v.scrapeMovie)
    types.push("movie");
  if (v.scrapeShow)
    types.push("show");
  return {
    type: "source",
    id: v.id,
    rank: v.rank,
    name: v.name,
    mediaTypes: types
  };
}
function formatEmbedMeta(v) {
  return {
    type: "embed",
    id: v.id,
    rank: v.rank,
    name: v.name
  };
}
function getAllSourceMetaSorted(list) {
  return list.sources.sort((a, b) => b.rank - a.rank).map(formatSourceMeta);
}
function getAllEmbedMetaSorted(list) {
  return list.embeds.sort((a, b) => b.rank - a.rank).map(formatEmbedMeta);
}
function getSpecificId(list, id) {
  const foundSource = list.sources.find((v) => v.id === id);
  if (foundSource) {
    return formatSourceMeta(foundSource);
  }
  const foundEmbed = list.embeds.find((v) => v.id === id);
  if (foundEmbed) {
    return formatEmbedMeta(foundEmbed);
  }
  return null;
}
function makeFullUrl(url, ops) {
  let leftSide = (ops == null ? void 0 : ops.baseUrl) ?? "";
  let rightSide = url;
  if (leftSide.length > 0 && !leftSide.endsWith("/"))
    leftSide += "/";
  if (rightSide.startsWith("/"))
    rightSide = rightSide.slice(1);
  const fullUrl = leftSide + rightSide;
  if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://"))
    throw new Error(`Invald URL -- URL doesn't start with a http scheme: '${fullUrl}'`);
  const parsedUrl = new URL(fullUrl);
  Object.entries((ops == null ? void 0 : ops.query) ?? {}).forEach(([k, v]) => {
    parsedUrl.searchParams.set(k, v);
  });
  return parsedUrl.toString();
}
function makeFetcher(fetcher) {
  const newFetcher = (url, ops) => {
    return fetcher(url, {
      headers: (ops == null ? void 0 : ops.headers) ?? {},
      method: (ops == null ? void 0 : ops.method) ?? "GET",
      query: (ops == null ? void 0 : ops.query) ?? {},
      baseUrl: (ops == null ? void 0 : ops.baseUrl) ?? "",
      readHeaders: (ops == null ? void 0 : ops.readHeaders) ?? [],
      body: ops == null ? void 0 : ops.body
    });
  };
  const output = async (url, ops) => (await newFetcher(url, ops)).body;
  output.full = newFetcher;
  return output;
}
const flags = {
  // CORS are set to allow any origin
  CORS_ALLOWED: "cors-allowed",
  // the stream is locked on IP, so only works if
  // request maker is same as player (not compatible with proxies)
  IP_LOCKED: "ip-locked",
  // The source/embed is blocking cloudflare ip's
  // This flag is not compatible with a proxy hosted on cloudflare
  CF_BLOCKED: "cf-blocked"
};
const targets = {
  // browser with CORS restrictions
  BROWSER: "browser",
  // browser, but no CORS restrictions through a browser extension
  BROWSER_EXTENSION: "browser-extension",
  // native app, so no restrictions in what can be played
  NATIVE: "native",
  // any target, no target restrictions
  ANY: "any"
};
const targetToFeatures = {
  browser: {
    requires: [flags.CORS_ALLOWED],
    disallowed: []
  },
  "browser-extension": {
    requires: [],
    disallowed: []
  },
  native: {
    requires: [],
    disallowed: []
  },
  any: {
    requires: [],
    disallowed: []
  }
};
function getTargetFeatures(target, consistentIpForRequests) {
  const features = targetToFeatures[target];
  if (!consistentIpForRequests)
    features.disallowed.push(flags.IP_LOCKED);
  return features;
}
function flagsAllowedInFeatures(features, inputFlags) {
  const hasAllFlags = features.requires.every((v) => inputFlags.includes(v));
  if (!hasAllFlags)
    return false;
  const hasDisallowedFlag = features.disallowed.some((v) => inputFlags.includes(v));
  if (hasDisallowedFlag)
    return false;
  return true;
}
function isValidStream$1(stream) {
  if (!stream)
    return false;
  if (stream.type === "hls") {
    if (!stream.playlist)
      return false;
    return true;
  }
  if (stream.type === "file") {
    const validQualities = Object.values(stream.qualities).filter((v) => v.url.length > 0);
    if (validQualities.length === 0)
      return false;
    return true;
  }
  return false;
}
async function scrapeInvidualSource(list, ops) {
  const sourceScraper = list.sources.find((v) => ops.id === v.id);
  if (!sourceScraper)
    throw new Error("Source with ID not found");
  if (ops.media.type === "movie" && !sourceScraper.scrapeMovie)
    throw new Error("Source is not compatible with movies");
  if (ops.media.type === "show" && !sourceScraper.scrapeShow)
    throw new Error("Source is not compatible with shows");
  const contextBase = {
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    progress(val) {
      var _a, _b;
      (_b = (_a = ops.events) == null ? void 0 : _a.update) == null ? void 0 : _b.call(_a, {
        id: sourceScraper.id,
        percentage: val,
        status: "pending"
      });
    }
  };
  let output = null;
  if (ops.media.type === "movie" && sourceScraper.scrapeMovie)
    output = await sourceScraper.scrapeMovie({
      ...contextBase,
      media: ops.media
    });
  else if (ops.media.type === "show" && sourceScraper.scrapeShow)
    output = await sourceScraper.scrapeShow({
      ...contextBase,
      media: ops.media
    });
  if (output == null ? void 0 : output.stream) {
    output.stream = output.stream.filter((stream) => isValidStream$1(stream)).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
  }
  if (!output)
    throw new Error("output is null");
  output.embeds = output.embeds.filter((embed) => {
    const e = list.embeds.find((v) => v.id === embed.embedId);
    if (!e || e.disabled)
      return false;
    return true;
  });
  if ((!output.stream || output.stream.length === 0) && output.embeds.length === 0)
    throw new NotFoundError("No streams found");
  return output;
}
async function scrapeIndividualEmbed(list, ops) {
  const embedScraper = list.embeds.find((v) => ops.id === v.id);
  if (!embedScraper)
    throw new Error("Embed with ID not found");
  const output = await embedScraper.scrape({
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    url: ops.url,
    progress(val) {
      var _a, _b;
      (_b = (_a = ops.events) == null ? void 0 : _a.update) == null ? void 0 : _b.call(_a, {
        id: embedScraper.id,
        percentage: val,
        status: "pending"
      });
    }
  });
  output.stream = output.stream.filter((stream) => isValidStream$1(stream)).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
  if (output.stream.length === 0)
    throw new NotFoundError("No streams found");
  return output;
}
function reorderOnIdList(order, list) {
  const copy = [...list];
  copy.sort((a, b) => {
    const aIndex = order.indexOf(a.id);
    const bIndex = order.indexOf(b.id);
    if (aIndex >= 0 && bIndex >= 0)
      return aIndex - bIndex;
    if (bIndex >= 0)
      return 1;
    if (aIndex >= 0)
      return -1;
    return b.rank - a.rank;
  });
  return copy;
}
async function runAllProviders(list, ops) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q;
  const sources = reorderOnIdList(ops.sourceOrder ?? [], list.sources).filter((v) => {
    if (ops.media.type === "movie")
      return !!v.scrapeMovie;
    if (ops.media.type === "show")
      return !!v.scrapeShow;
    return false;
  });
  const embeds = reorderOnIdList(ops.embedOrder ?? [], list.embeds);
  const embedIds = embeds.map((v) => v.id);
  let lastId = "";
  const contextBase = {
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    progress(val) {
      var _a2, _b2;
      (_b2 = (_a2 = ops.events) == null ? void 0 : _a2.update) == null ? void 0 : _b2.call(_a2, {
        id: lastId,
        percentage: val,
        status: "pending"
      });
    }
  };
  (_b = (_a = ops.events) == null ? void 0 : _a.init) == null ? void 0 : _b.call(_a, {
    sourceIds: sources.map((v) => v.id)
  });
  for (const s of sources) {
    (_d = (_c = ops.events) == null ? void 0 : _c.start) == null ? void 0 : _d.call(_c, s.id);
    lastId = s.id;
    let output = null;
    try {
      if (ops.media.type === "movie" && s.scrapeMovie)
        output = await s.scrapeMovie({
          ...contextBase,
          media: ops.media
        });
      else if (ops.media.type === "show" && s.scrapeShow)
        output = await s.scrapeShow({
          ...contextBase,
          media: ops.media
        });
      if (output) {
        output.stream = (output.stream ?? []).filter((stream) => isValidStream$1(stream)).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
      }
      if (!output)
        throw Error("No output");
      if ((!output.stream || output.stream.length === 0) && output.embeds.length === 0)
        throw new NotFoundError("No streams found");
    } catch (err) {
      if (err instanceof NotFoundError) {
        (_f = (_e = ops.events) == null ? void 0 : _e.update) == null ? void 0 : _f.call(_e, {
          id: s.id,
          percentage: 100,
          status: "notfound",
          reason: err.message
        });
        continue;
      }
      (_h = (_g = ops.events) == null ? void 0 : _g.update) == null ? void 0 : _h.call(_g, {
        id: s.id,
        percentage: 100,
        status: "failure",
        error: err
      });
      continue;
    }
    if (!output)
      throw new Error("Invalid media type");
    if ((_i = output.stream) == null ? void 0 : _i[0]) {
      return {
        sourceId: s.id,
        stream: output.stream[0]
      };
    }
    const sortedEmbeds = output.embeds.filter((embed) => {
      const e = list.embeds.find((v) => v.id === embed.embedId);
      if (!e || e.disabled)
        return false;
      return true;
    }).sort((a, b) => embedIds.indexOf(a.embedId) - embedIds.indexOf(b.embedId));
    if (sortedEmbeds.length > 0) {
      (_k = (_j = ops.events) == null ? void 0 : _j.discoverEmbeds) == null ? void 0 : _k.call(_j, {
        embeds: sortedEmbeds.map((v, i) => ({
          id: [s.id, i].join("-"),
          embedScraperId: v.embedId
        })),
        sourceId: s.id
      });
    }
    for (const ind in sortedEmbeds) {
      if (!Object.prototype.hasOwnProperty.call(sortedEmbeds, ind))
        continue;
      const e = sortedEmbeds[ind];
      const scraper = embeds.find((v) => v.id === e.embedId);
      if (!scraper)
        throw new Error("Invalid embed returned");
      const id = [s.id, ind].join("-");
      (_m = (_l = ops.events) == null ? void 0 : _l.start) == null ? void 0 : _m.call(_l, id);
      lastId = id;
      let embedOutput;
      try {
        embedOutput = await scraper.scrape({
          ...contextBase,
          url: e.url
        });
        embedOutput.stream = embedOutput.stream.filter((stream) => isValidStream$1(stream)).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
        if (embedOutput.stream.length === 0)
          throw new NotFoundError("No streams found");
      } catch (err) {
        if (err instanceof NotFoundError) {
          (_o = (_n = ops.events) == null ? void 0 : _n.update) == null ? void 0 : _o.call(_n, {
            id,
            percentage: 100,
            status: "notfound",
            reason: err.message
          });
          continue;
        }
        (_q = (_p = ops.events) == null ? void 0 : _p.update) == null ? void 0 : _q.call(_p, {
          id,
          percentage: 100,
          status: "failure",
          error: err
        });
        continue;
      }
      return {
        sourceId: s.id,
        embedId: scraper.id,
        stream: embedOutput.stream[0]
      };
    }
  }
  return null;
}
function makeControls(ops) {
  const list = {
    embeds: ops.embeds,
    sources: ops.sources
  };
  const providerRunnerOps = {
    features: ops.features,
    fetcher: makeFetcher(ops.fetcher),
    proxiedFetcher: makeFetcher(ops.proxiedFetcher ?? ops.fetcher)
  };
  return {
    runAll(runnerOps) {
      return runAllProviders(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    runSourceScraper(runnerOps) {
      return scrapeInvidualSource(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    runEmbedScraper(runnerOps) {
      return scrapeIndividualEmbed(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    getMetadata(id) {
      return getSpecificId(list, id);
    },
    listSources() {
      return getAllSourceMetaSorted(list);
    },
    listEmbeds() {
      return getAllEmbedMetaSorted(list);
    }
  };
}
function makeSourcerer(state) {
  const mediaTypes = [];
  if (state.scrapeMovie)
    mediaTypes.push("movie");
  if (state.scrapeShow)
    mediaTypes.push("show");
  return {
    ...state,
    type: "source",
    disabled: state.disabled ?? false,
    mediaTypes
  };
}
function makeEmbed(state) {
  return {
    ...state,
    type: "embed",
    disabled: state.disabled ?? false,
    mediaTypes: void 0
  };
}
const nanoid = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 10);
const doodScraper = makeEmbed({
  id: "dood",
  name: "dood",
  rank: 173,
  async scrape(ctx) {
    var _a, _b;
    const baseUrl3 = "https://d0000d.com";
    const id = ctx.url.split("/d/")[1] || ctx.url.split("/e/")[1];
    const doodData = await ctx.proxiedFetcher(`/e/${id}`, {
      method: "GET",
      baseUrl: baseUrl3
    });
    const dataForLater = (_a = doodData.match(/\?token=([^&]+)&expiry=/)) == null ? void 0 : _a[1];
    const path = (_b = doodData.match(/\$\.get\('\/pass_md5([^']+)/)) == null ? void 0 : _b[1];
    const doodPage = await ctx.proxiedFetcher(`/pass_md5${path}`, {
      headers: {
        Referer: `${baseUrl3}/e/${id}`
      },
      method: "GET",
      baseUrl: baseUrl3
    });
    const downloadURL = `${doodPage}${nanoid()}?token=${dataForLater}&expiry=${Date.now()}`;
    return {
      stream: [
        {
          id: "primary",
          type: "file",
          flags: [],
          captions: [],
          qualities: {
            unknown: {
              type: "mp4",
              url: downloadURL
            }
          },
          headers: {
            Referer: "https://d0000d.com/"
          }
        }
      ]
    };
  }
});
const febBoxBase = `https://www.febbox.com`;
function parseInputUrl(url) {
  const [type, id, seasonId, episodeId] = url.slice(1).split("/");
  const season = seasonId ? parseInt(seasonId, 10) : void 0;
  const episode = episodeId ? parseInt(episodeId, 10) : void 0;
  return {
    type,
    id,
    season,
    episode
  };
}
async function getFileList(ctx, shareKey, parentId) {
  var _a;
  const query = {
    share_key: shareKey,
    pwd: ""
  };
  if (parentId) {
    query.parent_id = parentId.toString();
    query.page = "1";
  }
  const streams = await ctx.proxiedFetcher("/file/file_share_list", {
    headers: {
      "accept-language": "en"
      // without this header, the request is marked as a webscraper
    },
    baseUrl: febBoxBase,
    query
  });
  return ((_a = streams.data) == null ? void 0 : _a.file_list) ?? [];
}
function isValidStream(file) {
  return file.ext === "mp4" || file.ext === "mkv";
}
async function getStreams(ctx, shareKey, type, season, episode) {
  const streams = await getFileList(ctx, shareKey);
  if (type === "show") {
    const seasonFolder = streams.find((v) => {
      if (!v.is_dir)
        return false;
      return v.file_name.toLowerCase() === `season ${season}`;
    });
    if (!seasonFolder)
      return [];
    const episodes = await getFileList(ctx, shareKey, seasonFolder.fid);
    const s = (season == null ? void 0 : season.toString()) ?? "0";
    const e = (episode == null ? void 0 : episode.toString()) ?? "0";
    const episodeRegex = new RegExp(`[Ss]0*${s}[Ee]0*${e}`);
    return episodes.filter((file) => {
      if (file.is_dir)
        return false;
      const match = file.file_name.match(episodeRegex);
      if (!match)
        return false;
      return true;
    }).filter(isValidStream);
  }
  return streams.filter((v) => !v.is_dir).filter(isValidStream);
}
const captionTypes = {
  srt: "srt",
  vtt: "vtt"
};
function getCaptionTypeFromUrl(url) {
  const extensions = Object.keys(captionTypes);
  const type = extensions.find((v) => url.endsWith(`.${v}`));
  if (!type)
    return null;
  return type;
}
function labelToLanguageCode(label) {
  const code = ISO6391.getCode(label);
  if (code.length === 0)
    return null;
  return code;
}
function isValidLanguageCode(code) {
  if (!code)
    return false;
  return ISO6391.validate(code);
}
function removeDuplicatedLanguages(list) {
  const beenSeen = {};
  return list.filter((sub) => {
    if (beenSeen[sub.language])
      return false;
    beenSeen[sub.language] = true;
    return true;
  });
}
const iv = atob("d0VpcGhUbiE=");
const key = atob("MTIzZDZjZWRmNjI2ZHk1NDIzM2FhMXc2");
const apiUrls = [
  atob("aHR0cHM6Ly9zaG93Ym94LnNoZWd1Lm5ldC9hcGkvYXBpX2NsaWVudC9pbmRleC8="),
  atob("aHR0cHM6Ly9tYnBhcGkuc2hlZ3UubmV0L2FwaS9hcGlfY2xpZW50L2luZGV4Lw==")
];
const appKey = atob("bW92aWVib3g=");
const appId = atob("Y29tLnRkby5zaG93Ym94");
const captionsDomains = [atob("bWJwaW1hZ2VzLmNodWF4aW4uY29t"), atob("aW1hZ2VzLnNoZWd1Lm5ldA==")];
const showboxBase = "https://www.showbox.media";
function encrypt(str) {
  return CryptoJS.TripleDES.encrypt(str, CryptoJS.enc.Utf8.parse(key), {
    iv: CryptoJS.enc.Utf8.parse(iv)
  }).toString();
}
function getVerify(str, str2, str3) {
  if (str) {
    return CryptoJS.MD5(CryptoJS.MD5(str2).toString() + str3 + str).toString();
  }
  return null;
}
const randomId = customAlphabet("1234567890abcdef");
const expiry = () => Math.floor(Date.now() / 1e3 + 60 * 60 * 12);
const sendRequest = async (ctx, data2, altApi = false) => {
  const defaultData = {
    childmode: "0",
    app_version: "11.5",
    appid: appId,
    lang: "en",
    expired_date: `${expiry()}`,
    platform: "android",
    channel: "Website"
  };
  const encryptedData = encrypt(
    JSON.stringify({
      ...defaultData,
      ...data2
    })
  );
  const appKeyHash = CryptoJS.MD5(appKey).toString();
  const verify = getVerify(encryptedData, appKey, key);
  const body = JSON.stringify({
    app_key: appKeyHash,
    verify,
    encrypt_data: encryptedData
  });
  const base64body = btoa(body);
  const formatted = new URLSearchParams();
  formatted.append("data", base64body);
  formatted.append("appid", "27");
  formatted.append("platform", "android");
  formatted.append("version", "129");
  formatted.append("medium", "Website");
  formatted.append("token", randomId(32));
  const requestUrl = altApi ? apiUrls[1] : apiUrls[0];
  const response = await ctx.proxiedFetcher(requestUrl, {
    method: "POST",
    headers: {
      Platform: "android",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "okhttp/3.2.0"
    },
    body: formatted
  });
  return JSON.parse(response);
};
async function getSubtitles(ctx, id, fid, type, episodeId, seasonId) {
  const module = type === "movie" ? "Movie_srt_list_v2" : "TV_srt_list_v2";
  const subtitleApiQuery = {
    fid,
    uid: "",
    module,
    mid: type === "movie" ? id : void 0,
    tid: type !== "movie" ? id : void 0,
    episode: episodeId == null ? void 0 : episodeId.toString(),
    season: seasonId == null ? void 0 : seasonId.toString()
  };
  const subResult = await sendRequest(ctx, subtitleApiQuery);
  const subtitleList = subResult.data.list;
  let output = [];
  subtitleList.forEach((sub) => {
    const subtitle = sub.subtitles.sort((a, b) => b.order - a.order)[0];
    if (!subtitle)
      return;
    const subtitleFilePath = subtitle.file_path.replace(captionsDomains[0], captionsDomains[1]).replace(/\s/g, "+").replace(/[()]/g, (c) => {
      return `%${c.charCodeAt(0).toString(16)}`;
    });
    const subtitleType = getCaptionTypeFromUrl(subtitleFilePath);
    if (!subtitleType)
      return;
    const validCode = isValidLanguageCode(subtitle.lang);
    if (!validCode)
      return;
    output.push({
      id: subtitleFilePath,
      language: subtitle.lang,
      hasCorsRestrictions: true,
      type: subtitleType,
      url: subtitleFilePath
    });
  });
  output = removeDuplicatedLanguages(output);
  return output;
}
function extractShareKey(url) {
  const parsedUrl = new URL(url);
  const shareKey = parsedUrl.pathname.split("/")[2];
  return shareKey;
}
const febboxHlsScraper = makeEmbed({
  id: "febbox-hls",
  name: "Febbox (HLS)",
  rank: 160,
  disabled: true,
  async scrape(ctx) {
    var _a;
    const { type, id, season, episode } = parseInputUrl(ctx.url);
    const sharelinkResult = await ctx.proxiedFetcher("/index/share_link", {
      baseUrl: showboxBase,
      query: {
        id,
        type: type === "movie" ? "1" : "2"
      }
    });
    if (!((_a = sharelinkResult == null ? void 0 : sharelinkResult.data) == null ? void 0 : _a.link))
      throw new Error("No embed url found");
    ctx.progress(30);
    const shareKey = extractShareKey(sharelinkResult.data.link);
    const fileList = await getStreams(ctx, shareKey, type, season, episode);
    const firstStream = fileList[0];
    if (!firstStream)
      throw new Error("No playable mp4 stream found");
    ctx.progress(70);
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          flags: [],
          captions: await getSubtitles(ctx, id, firstStream.fid, type, season, episode),
          playlist: `https://www.febbox.com/hls/main/${firstStream.oss_fid}.m3u8`
        }
      ]
    };
  }
});
const allowedQualities = ["360", "480", "720", "1080", "4k"];
function mapToQuality(quality) {
  const q = quality.real_quality.replace("p", "").toLowerCase();
  if (!allowedQualities.includes(q))
    return null;
  return {
    real_quality: q,
    path: quality.path,
    fid: quality.fid
  };
}
async function getStreamQualities(ctx, apiQuery) {
  var _a;
  const mediaRes = (await sendRequest(ctx, apiQuery)).data;
  const qualityMap = mediaRes.list.map((v) => mapToQuality(v)).filter((v) => !!v);
  const qualities = {};
  allowedQualities.forEach((quality) => {
    const foundQuality = qualityMap.find((q) => q.real_quality === quality && q.path);
    if (foundQuality) {
      qualities[quality] = {
        type: "mp4",
        url: foundQuality.path
      };
    }
  });
  return {
    qualities,
    fid: (_a = mediaRes.list[0]) == null ? void 0 : _a.fid
  };
}
const febboxMp4Scraper = makeEmbed({
  id: "febbox-mp4",
  name: "Febbox (MP4)",
  rank: 190,
  async scrape(ctx) {
    const { type, id, season, episode } = parseInputUrl(ctx.url);
    let apiQuery = null;
    if (type === "movie") {
      apiQuery = {
        uid: "",
        module: "Movie_downloadurl_v3",
        mid: id,
        oss: "1",
        group: ""
      };
    } else if (type === "show") {
      apiQuery = {
        uid: "",
        module: "TV_downloadurl_v3",
        tid: id,
        season,
        episode,
        oss: "1",
        group: ""
      };
    }
    if (!apiQuery)
      throw Error("Incorrect type");
    const { qualities, fid } = await getStreamQualities(ctx, apiQuery);
    if (fid === void 0)
      throw new Error("No streamable file found");
    ctx.progress(70);
    return {
      stream: [
        {
          id: "primary",
          captions: await getSubtitles(ctx, id, fid, type, episode, season),
          qualities,
          type: "file",
          flags: [flags.CORS_ALLOWED]
        }
      ]
    };
  }
});
const packedRegex$1 = /(eval\(function\(p,a,c,k,e,d\){.*{}\)\))/;
const linkRegex$2 = /MDCore\.wurl="(.*?)";/;
const mixdropScraper = makeEmbed({
  id: "mixdrop",
  name: "MixDrop",
  rank: 198,
  async scrape(ctx) {
    const streamRes = await ctx.proxiedFetcher(ctx.url);
    const packed = streamRes.match(packedRegex$1);
    if (!packed) {
      throw new Error("failed to find packed mixdrop JavaScript");
    }
    const unpacked = unpacker.unpack(packed[1]);
    const link = unpacked.match(linkRegex$2);
    if (!link) {
      throw new Error("failed to find packed mixdrop source link");
    }
    const url = link[1];
    return {
      stream: [
        {
          id: "primary",
          type: "file",
          flags: [],
          captions: [],
          qualities: {
            unknown: {
              type: "mp4",
              url: url.startsWith("http") ? url : `https:${url}`,
              // URLs don't always start with the protocol
              headers: {
                // MixDrop requires this header on all streams
                Referer: "https://mixdrop.co/"
              }
            }
          }
        }
      ]
    };
  }
});
const mp4uploadScraper = makeEmbed({
  id: "mp4upload",
  name: "mp4upload",
  rank: 170,
  async scrape(ctx) {
    const embed = await ctx.proxiedFetcher(ctx.url);
    const playerSrcRegex = new RegExp('(?<=player\\.src\\()\\s*{\\s*type:\\s*"[^"]+",\\s*src:\\s*"([^"]+)"\\s*}\\s*(?=\\);)', "s");
    const playerSrc = embed.match(playerSrcRegex) ?? [];
    const streamUrl = playerSrc[1];
    if (!streamUrl)
      throw new Error("Stream url not found in embed code");
    return {
      stream: [
        {
          id: "primary",
          type: "file",
          flags: [flags.CORS_ALLOWED],
          captions: [],
          qualities: {
            "1080": {
              type: "mp4",
              url: streamUrl
            }
          }
        }
      ]
    };
  }
});
const hunterRegex = /eval\(function\(h,u,n,t,e,r\).*?\("(.*?)",\d*?,"(.*?)",(\d*?),(\d*?),\d*?\)\)/;
const linkRegex$1 = /file:"(.*?)"/;
function decodeHunter(encoded, mask, charCodeOffset, delimiterOffset) {
  const delimiter = mask[delimiterOffset];
  const chunks = encoded.split(delimiter).filter((chunk) => chunk);
  const decoded = chunks.map((chunk) => {
    const charCode = chunk.split("").reduceRight((c, value, index) => {
      return c + mask.indexOf(value) * delimiterOffset ** (chunk.length - 1 - index);
    }, 0);
    return String.fromCharCode(charCode - charCodeOffset);
  }).join("");
  return decoded;
}
const streambucketScraper = makeEmbed({
  id: "streambucket",
  name: "StreamBucket",
  rank: 196,
  // TODO - Disabled until ctx.fetcher and ctx.proxiedFetcher don't trigger bot detection
  disabled: true,
  async scrape(ctx) {
    const response = await fetch(ctx.url);
    const html = await response.text();
    if (html.includes("captcha-checkbox")) {
      throw new Error("StreamBucket got captchaed");
    }
    let regexResult = html.match(hunterRegex);
    if (!regexResult) {
      throw new Error("Failed to find StreamBucket hunter JavaScript");
    }
    const encoded = regexResult[1];
    const mask = regexResult[2];
    const charCodeOffset = Number(regexResult[3]);
    const delimiterOffset = Number(regexResult[4]);
    if (Number.isNaN(charCodeOffset)) {
      throw new Error("StreamBucket hunter JavaScript charCodeOffset is not a valid number");
    }
    if (Number.isNaN(delimiterOffset)) {
      throw new Error("StreamBucket hunter JavaScript delimiterOffset is not a valid number");
    }
    const decoded = decodeHunter(encoded, mask, charCodeOffset, delimiterOffset);
    regexResult = decoded.match(linkRegex$1);
    if (!regexResult) {
      throw new Error("Failed to find StreamBucket HLS link");
    }
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: regexResult[1],
          flags: [flags.CORS_ALLOWED],
          captions: []
        }
      ]
    };
  }
});
var commonjsGlobal = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : {};
function getDefaultExportFromCjs(x) {
  return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
function getAugmentedNamespace(n) {
  if (n.__esModule)
    return n;
  var f = n.default;
  if (typeof f == "function") {
    var a = function a2() {
      if (this instanceof a2) {
        return Reflect.construct(f, arguments, this.constructor);
      }
      return f.apply(this, arguments);
    };
    a.prototype = f.prototype;
  } else
    a = {};
  Object.defineProperty(a, "__esModule", { value: true });
  Object.keys(n).forEach(function (k) {
    var d = Object.getOwnPropertyDescriptor(n, k);
    Object.defineProperty(a, k, d.get ? d : {
      enumerable: true,
      get: function () {
        return n[k];
      }
    });
  });
  return a;
}
var encBase64 = { exports: {} };
function commonjsRequire(path) {
  throw new Error('Could not dynamically require "' + path + '". Please configure the dynamicRequireTargets or/and ignoreDynamicRequires option of @rollup/plugin-commonjs appropriately for this require call to work.');
}
var core = { exports: {} };
const __viteBrowserExternal = {};
const __viteBrowserExternal$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: __viteBrowserExternal
}, Symbol.toStringTag, { value: "Module" }));
const require$$0 = /* @__PURE__ */ getAugmentedNamespace(__viteBrowserExternal$1);
var hasRequiredCore;
function requireCore() {
  if (hasRequiredCore)
    return core.exports;
  hasRequiredCore = 1;
  (function (module, exports) {
    (function (root, factory) {
      {
        module.exports = factory();
      }
    })(commonjsGlobal, function () {
      var CryptoJS2 = CryptoJS2 || function (Math2, undefined$1) {
        var crypto;
        if (typeof window !== "undefined" && window.crypto) {
          crypto = window.crypto;
        }
        if (typeof self !== "undefined" && self.crypto) {
          crypto = self.crypto;
        }
        if (typeof globalThis !== "undefined" && globalThis.crypto) {
          crypto = globalThis.crypto;
        }
        if (!crypto && typeof window !== "undefined" && window.msCrypto) {
          crypto = window.msCrypto;
        }
        if (!crypto && typeof commonjsGlobal !== "undefined" && commonjsGlobal.crypto) {
          crypto = commonjsGlobal.crypto;
        }
        if (!crypto && typeof commonjsRequire === "function") {
          try {
            crypto = require$$0;
          } catch (err) {
          }
        }
        var cryptoSecureRandomInt = function () {
          if (crypto) {
            if (typeof crypto.getRandomValues === "function") {
              try {
                return crypto.getRandomValues(new Uint32Array(1))[0];
              } catch (err) {
              }
            }
            if (typeof crypto.randomBytes === "function") {
              try {
                return crypto.randomBytes(4).readInt32LE();
              } catch (err) {
              }
            }
          }
          throw new Error("Native crypto module could not be used to get secure random number.");
        };
        var create = Object.create || function () {
          function F() {
          }
          return function (obj) {
            var subtype;
            F.prototype = obj;
            subtype = new F();
            F.prototype = null;
            return subtype;
          };
        }();
        var C = {};
        var C_lib = C.lib = {};
        var Base = C_lib.Base = function () {
          return {
            /**
             * Creates a new object that inherits from this object.
             *
             * @param {Object} overrides Properties to copy into the new object.
             *
             * @return {Object} The new object.
             *
             * @static
             *
             * @example
             *
             *     var MyType = CryptoJS.lib.Base.extend({
             *         field: 'value',
             *
             *         method: function () {
             *         }
             *     });
             */
            extend: function (overrides) {
              var subtype = create(this);
              if (overrides) {
                subtype.mixIn(overrides);
              }
              if (!subtype.hasOwnProperty("init") || this.init === subtype.init) {
                subtype.init = function () {
                  subtype.$super.init.apply(this, arguments);
                };
              }
              subtype.init.prototype = subtype;
              subtype.$super = this;
              return subtype;
            },
            /**
             * Extends this object and runs the init method.
             * Arguments to create() will be passed to init().
             *
             * @return {Object} The new object.
             *
             * @static
             *
             * @example
             *
             *     var instance = MyType.create();
             */
            create: function () {
              var instance = this.extend();
              instance.init.apply(instance, arguments);
              return instance;
            },
            /**
             * Initializes a newly created object.
             * Override this method to add some logic when your objects are created.
             *
             * @example
             *
             *     var MyType = CryptoJS.lib.Base.extend({
             *         init: function () {
             *             // ...
             *         }
             *     });
             */
            init: function () {
            },
            /**
             * Copies properties into this object.
             *
             * @param {Object} properties The properties to mix in.
             *
             * @example
             *
             *     MyType.mixIn({
             *         field: 'value'
             *     });
             */
            mixIn: function (properties) {
              for (var propertyName in properties) {
                if (properties.hasOwnProperty(propertyName)) {
                  this[propertyName] = properties[propertyName];
                }
              }
              if (properties.hasOwnProperty("toString")) {
                this.toString = properties.toString;
              }
            },
            /**
             * Creates a copy of this object.
             *
             * @return {Object} The clone.
             *
             * @example
             *
             *     var clone = instance.clone();
             */
            clone: function () {
              return this.init.prototype.extend(this);
            }
          };
        }();
        var WordArray = C_lib.WordArray = Base.extend({
          /**
           * Initializes a newly created word array.
           *
           * @param {Array} words (Optional) An array of 32-bit words.
           * @param {number} sigBytes (Optional) The number of significant bytes in the words.
           *
           * @example
           *
           *     var wordArray = CryptoJS.lib.WordArray.create();
           *     var wordArray = CryptoJS.lib.WordArray.create([0x00010203, 0x04050607]);
           *     var wordArray = CryptoJS.lib.WordArray.create([0x00010203, 0x04050607], 6);
           */
          init: function (words, sigBytes) {
            words = this.words = words || [];
            if (sigBytes != undefined$1) {
              this.sigBytes = sigBytes;
            } else {
              this.sigBytes = words.length * 4;
            }
          },
          /**
           * Converts this word array to a string.
           *
           * @param {Encoder} encoder (Optional) The encoding strategy to use. Default: CryptoJS.enc.Hex
           *
           * @return {string} The stringified word array.
           *
           * @example
           *
           *     var string = wordArray + '';
           *     var string = wordArray.toString();
           *     var string = wordArray.toString(CryptoJS.enc.Utf8);
           */
          toString: function (encoder) {
            return (encoder || Hex).stringify(this);
          },
          /**
           * Concatenates a word array to this word array.
           *
           * @param {WordArray} wordArray The word array to append.
           *
           * @return {WordArray} This word array.
           *
           * @example
           *
           *     wordArray1.concat(wordArray2);
           */
          concat: function (wordArray) {
            var thisWords = this.words;
            var thatWords = wordArray.words;
            var thisSigBytes = this.sigBytes;
            var thatSigBytes = wordArray.sigBytes;
            this.clamp();
            if (thisSigBytes % 4) {
              for (var i = 0; i < thatSigBytes; i++) {
                var thatByte = thatWords[i >>> 2] >>> 24 - i % 4 * 8 & 255;
                thisWords[thisSigBytes + i >>> 2] |= thatByte << 24 - (thisSigBytes + i) % 4 * 8;
              }
            } else {
              for (var j = 0; j < thatSigBytes; j += 4) {
                thisWords[thisSigBytes + j >>> 2] = thatWords[j >>> 2];
              }
            }
            this.sigBytes += thatSigBytes;
            return this;
          },
          /**
           * Removes insignificant bits.
           *
           * @example
           *
           *     wordArray.clamp();
           */
          clamp: function () {
            var words = this.words;
            var sigBytes = this.sigBytes;
            words[sigBytes >>> 2] &= 4294967295 << 32 - sigBytes % 4 * 8;
            words.length = Math2.ceil(sigBytes / 4);
          },
          /**
           * Creates a copy of this word array.
           *
           * @return {WordArray} The clone.
           *
           * @example
           *
           *     var clone = wordArray.clone();
           */
          clone: function () {
            var clone = Base.clone.call(this);
            clone.words = this.words.slice(0);
            return clone;
          },
          /**
           * Creates a word array filled with random bytes.
           *
           * @param {number} nBytes The number of random bytes to generate.
           *
           * @return {WordArray} The random word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.lib.WordArray.random(16);
           */
          random: function (nBytes) {
            var words = [];
            for (var i = 0; i < nBytes; i += 4) {
              words.push(cryptoSecureRandomInt());
            }
            return new WordArray.init(words, nBytes);
          }
        });
        var C_enc = C.enc = {};
        var Hex = C_enc.Hex = {
          /**
           * Converts a word array to a hex string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @return {string} The hex string.
           *
           * @static
           *
           * @example
           *
           *     var hexString = CryptoJS.enc.Hex.stringify(wordArray);
           */
          stringify: function (wordArray) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            var hexChars = [];
            for (var i = 0; i < sigBytes; i++) {
              var bite = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
              hexChars.push((bite >>> 4).toString(16));
              hexChars.push((bite & 15).toString(16));
            }
            return hexChars.join("");
          },
          /**
           * Converts a hex string to a word array.
           *
           * @param {string} hexStr The hex string.
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Hex.parse(hexString);
           */
          parse: function (hexStr) {
            var hexStrLength = hexStr.length;
            var words = [];
            for (var i = 0; i < hexStrLength; i += 2) {
              words[i >>> 3] |= parseInt(hexStr.substr(i, 2), 16) << 24 - i % 8 * 4;
            }
            return new WordArray.init(words, hexStrLength / 2);
          }
        };
        var Latin1 = C_enc.Latin1 = {
          /**
           * Converts a word array to a Latin1 string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @return {string} The Latin1 string.
           *
           * @static
           *
           * @example
           *
           *     var latin1String = CryptoJS.enc.Latin1.stringify(wordArray);
           */
          stringify: function (wordArray) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            var latin1Chars = [];
            for (var i = 0; i < sigBytes; i++) {
              var bite = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
              latin1Chars.push(String.fromCharCode(bite));
            }
            return latin1Chars.join("");
          },
          /**
           * Converts a Latin1 string to a word array.
           *
           * @param {string} latin1Str The Latin1 string.
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Latin1.parse(latin1String);
           */
          parse: function (latin1Str) {
            var latin1StrLength = latin1Str.length;
            var words = [];
            for (var i = 0; i < latin1StrLength; i++) {
              words[i >>> 2] |= (latin1Str.charCodeAt(i) & 255) << 24 - i % 4 * 8;
            }
            return new WordArray.init(words, latin1StrLength);
          }
        };
        var Utf82 = C_enc.Utf8 = {
          /**
           * Converts a word array to a UTF-8 string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @return {string} The UTF-8 string.
           *
           * @static
           *
           * @example
           *
           *     var utf8String = CryptoJS.enc.Utf8.stringify(wordArray);
           */
          stringify: function (wordArray) {
            try {
              return decodeURIComponent(escape(Latin1.stringify(wordArray)));
            } catch (e) {
              throw new Error("Malformed UTF-8 data");
            }
          },
          /**
           * Converts a UTF-8 string to a word array.
           *
           * @param {string} utf8Str The UTF-8 string.
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Utf8.parse(utf8String);
           */
          parse: function (utf8Str) {
            return Latin1.parse(unescape(encodeURIComponent(utf8Str)));
          }
        };
        var BufferedBlockAlgorithm = C_lib.BufferedBlockAlgorithm = Base.extend({
          /**
           * Resets this block algorithm's data buffer to its initial state.
           *
           * @example
           *
           *     bufferedBlockAlgorithm.reset();
           */
          reset: function () {
            this._data = new WordArray.init();
            this._nDataBytes = 0;
          },
          /**
           * Adds new data to this block algorithm's buffer.
           *
           * @param {WordArray|string} data The data to append. Strings are converted to a WordArray using UTF-8.
           *
           * @example
           *
           *     bufferedBlockAlgorithm._append('data');
           *     bufferedBlockAlgorithm._append(wordArray);
           */
          _append: function (data2) {
            if (typeof data2 == "string") {
              data2 = Utf82.parse(data2);
            }
            this._data.concat(data2);
            this._nDataBytes += data2.sigBytes;
          },
          /**
           * Processes available data blocks.
           *
           * This method invokes _doProcessBlock(offset), which must be implemented by a concrete subtype.
           *
           * @param {boolean} doFlush Whether all blocks and partial blocks should be processed.
           *
           * @return {WordArray} The processed data.
           *
           * @example
           *
           *     var processedData = bufferedBlockAlgorithm._process();
           *     var processedData = bufferedBlockAlgorithm._process(!!'flush');
           */
          _process: function (doFlush) {
            var processedWords;
            var data2 = this._data;
            var dataWords = data2.words;
            var dataSigBytes = data2.sigBytes;
            var blockSize = this.blockSize;
            var blockSizeBytes = blockSize * 4;
            var nBlocksReady = dataSigBytes / blockSizeBytes;
            if (doFlush) {
              nBlocksReady = Math2.ceil(nBlocksReady);
            } else {
              nBlocksReady = Math2.max((nBlocksReady | 0) - this._minBufferSize, 0);
            }
            var nWordsReady = nBlocksReady * blockSize;
            var nBytesReady = Math2.min(nWordsReady * 4, dataSigBytes);
            if (nWordsReady) {
              for (var offset = 0; offset < nWordsReady; offset += blockSize) {
                this._doProcessBlock(dataWords, offset);
              }
              processedWords = dataWords.splice(0, nWordsReady);
              data2.sigBytes -= nBytesReady;
            }
            return new WordArray.init(processedWords, nBytesReady);
          },
          /**
           * Creates a copy of this object.
           *
           * @return {Object} The clone.
           *
           * @example
           *
           *     var clone = bufferedBlockAlgorithm.clone();
           */
          clone: function () {
            var clone = Base.clone.call(this);
            clone._data = this._data.clone();
            return clone;
          },
          _minBufferSize: 0
        });
        C_lib.Hasher = BufferedBlockAlgorithm.extend({
          /**
           * Configuration options.
           */
          cfg: Base.extend(),
          /**
           * Initializes a newly created hasher.
           *
           * @param {Object} cfg (Optional) The configuration options to use for this hash computation.
           *
           * @example
           *
           *     var hasher = CryptoJS.algo.SHA256.create();
           */
          init: function (cfg) {
            this.cfg = this.cfg.extend(cfg);
            this.reset();
          },
          /**
           * Resets this hasher to its initial state.
           *
           * @example
           *
           *     hasher.reset();
           */
          reset: function () {
            BufferedBlockAlgorithm.reset.call(this);
            this._doReset();
          },
          /**
           * Updates this hasher with a message.
           *
           * @param {WordArray|string} messageUpdate The message to append.
           *
           * @return {Hasher} This hasher.
           *
           * @example
           *
           *     hasher.update('message');
           *     hasher.update(wordArray);
           */
          update: function (messageUpdate) {
            this._append(messageUpdate);
            this._process();
            return this;
          },
          /**
           * Finalizes the hash computation.
           * Note that the finalize operation is effectively a destructive, read-once operation.
           *
           * @param {WordArray|string} messageUpdate (Optional) A final message update.
           *
           * @return {WordArray} The hash.
           *
           * @example
           *
           *     var hash = hasher.finalize();
           *     var hash = hasher.finalize('message');
           *     var hash = hasher.finalize(wordArray);
           */
          finalize: function (messageUpdate) {
            if (messageUpdate) {
              this._append(messageUpdate);
            }
            var hash = this._doFinalize();
            return hash;
          },
          blockSize: 512 / 32,
          /**
           * Creates a shortcut function to a hasher's object interface.
           *
           * @param {Hasher} hasher The hasher to create a helper for.
           *
           * @return {Function} The shortcut function.
           *
           * @static
           *
           * @example
           *
           *     var SHA256 = CryptoJS.lib.Hasher._createHelper(CryptoJS.algo.SHA256);
           */
          _createHelper: function (hasher) {
            return function (message, cfg) {
              return new hasher.init(cfg).finalize(message);
            };
          },
          /**
           * Creates a shortcut function to the HMAC's object interface.
           *
           * @param {Hasher} hasher The hasher to use in this HMAC helper.
           *
           * @return {Function} The shortcut function.
           *
           * @static
           *
           * @example
           *
           *     var HmacSHA256 = CryptoJS.lib.Hasher._createHmacHelper(CryptoJS.algo.SHA256);
           */
          _createHmacHelper: function (hasher) {
            return function (message, key2) {
              return new C_algo.HMAC.init(hasher, key2).finalize(message);
            };
          }
        });
        var C_algo = C.algo = {};
        return C;
      }(Math);
      return CryptoJS2;
    });
  })(core);
  return core.exports;
}
(function (module, exports) {
  (function (root, factory) {
    {
      module.exports = factory(requireCore());
    }
  })(commonjsGlobal, function (CryptoJS2) {
    (function () {
      var C = CryptoJS2;
      var C_lib = C.lib;
      var WordArray = C_lib.WordArray;
      var C_enc = C.enc;
      C_enc.Base64 = {
        /**
         * Converts a word array to a Base64 string.
         *
         * @param {WordArray} wordArray The word array.
         *
         * @return {string} The Base64 string.
         *
         * @static
         *
         * @example
         *
         *     var base64String = CryptoJS.enc.Base64.stringify(wordArray);
         */
        stringify: function (wordArray) {
          var words = wordArray.words;
          var sigBytes = wordArray.sigBytes;
          var map = this._map;
          wordArray.clamp();
          var base64Chars = [];
          for (var i = 0; i < sigBytes; i += 3) {
            var byte1 = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
            var byte2 = words[i + 1 >>> 2] >>> 24 - (i + 1) % 4 * 8 & 255;
            var byte3 = words[i + 2 >>> 2] >>> 24 - (i + 2) % 4 * 8 & 255;
            var triplet = byte1 << 16 | byte2 << 8 | byte3;
            for (var j = 0; j < 4 && i + j * 0.75 < sigBytes; j++) {
              base64Chars.push(map.charAt(triplet >>> 6 * (3 - j) & 63));
            }
          }
          var paddingChar = map.charAt(64);
          if (paddingChar) {
            while (base64Chars.length % 4) {
              base64Chars.push(paddingChar);
            }
          }
          return base64Chars.join("");
        },
        /**
         * Converts a Base64 string to a word array.
         *
         * @param {string} base64Str The Base64 string.
         *
         * @return {WordArray} The word array.
         *
         * @static
         *
         * @example
         *
         *     var wordArray = CryptoJS.enc.Base64.parse(base64String);
         */
        parse: function (base64Str) {
          var base64StrLength = base64Str.length;
          var map = this._map;
          var reverseMap = this._reverseMap;
          if (!reverseMap) {
            reverseMap = this._reverseMap = [];
            for (var j = 0; j < map.length; j++) {
              reverseMap[map.charCodeAt(j)] = j;
            }
          }
          var paddingChar = map.charAt(64);
          if (paddingChar) {
            var paddingIndex = base64Str.indexOf(paddingChar);
            if (paddingIndex !== -1) {
              base64StrLength = paddingIndex;
            }
          }
          return parseLoop(base64Str, base64StrLength, reverseMap);
        },
        _map: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
      };
      function parseLoop(base64Str, base64StrLength, reverseMap) {
        var words = [];
        var nBytes = 0;
        for (var i = 0; i < base64StrLength; i++) {
          if (i % 4) {
            var bits1 = reverseMap[base64Str.charCodeAt(i - 1)] << i % 4 * 2;
            var bits2 = reverseMap[base64Str.charCodeAt(i)] >>> 6 - i % 4 * 2;
            var bitsCombined = bits1 | bits2;
            words[nBytes >>> 2] |= bitsCombined << 24 - nBytes % 4 * 8;
            nBytes++;
          }
        }
        return WordArray.create(words, nBytes);
      }
    })();
    return CryptoJS2.enc.Base64;
  });
})(encBase64);
var encBase64Exports = encBase64.exports;
const Base64 = /* @__PURE__ */ getDefaultExportFromCjs(encBase64Exports);
var encUtf8 = { exports: {} };
(function (module, exports) {
  (function (root, factory) {
    {
      module.exports = factory(requireCore());
    }
  })(commonjsGlobal, function (CryptoJS2) {
    return CryptoJS2.enc.Utf8;
  });
})(encUtf8);
var encUtf8Exports = encUtf8.exports;
const Utf8 = /* @__PURE__ */ getDefaultExportFromCjs(encUtf8Exports);
async function fetchCaptchaToken(ctx, domain, recaptchaKey) {
  const domainHash = Base64.stringify(Utf8.parse(domain)).replace(/=/g, ".");
  const recaptchaRender = await ctx.proxiedFetcher(`https://www.google.com/recaptcha/api.js`, {
    query: {
      render: recaptchaKey
    }
  });
  const vToken = recaptchaRender.substring(
    recaptchaRender.indexOf("/releases/") + 10,
    recaptchaRender.indexOf("/recaptcha__en.js")
  );
  const recaptchaAnchor = await ctx.proxiedFetcher(
    `https://www.google.com/recaptcha/api2/anchor?cb=1&hl=en&size=invisible&cb=flicklax`,
    {
      query: {
        k: recaptchaKey,
        co: domainHash,
        v: vToken
      }
    }
  );
  const cToken = load(recaptchaAnchor)("#recaptcha-token").attr("value");
  if (!cToken)
    throw new Error("Unable to find cToken");
  const tokenData = await ctx.proxiedFetcher(`https://www.google.com/recaptcha/api2/reload`, {
    query: {
      v: vToken,
      reason: "q",
      k: recaptchaKey,
      c: cToken,
      sa: "",
      co: domain
    },
    headers: { referer: "https://www.google.com/recaptcha/api2/" },
    method: "POST"
  });
  const token = tokenData.match('rresp","(.+?)"');
  return token ? token[1] : null;
}
const streamsbScraper = makeEmbed({
  id: "streamsb",
  name: "StreamSB",
  rank: 150,
  async scrape(ctx) {
    const streamsbUrl = ctx.url.replace(".html", "").replace("embed-", "").replace("e/", "").replace("d/", "");
    const parsedUrl = new URL(streamsbUrl);
    const base = await ctx.proxiedFetcher(`${parsedUrl.origin}/d${parsedUrl.pathname}`);
    ctx.progress(20);
    const pageDoc = load(base);
    const dlDetails = [];
    pageDoc("[onclick^=download_video]").each((i, el) => {
      const $el = pageDoc(el);
      const funcContents = $el.attr("onclick");
      const regExpFunc = /download_video\('(.+?)','(.+?)','(.+?)'\)/;
      const matchesFunc = regExpFunc.exec(funcContents ?? "");
      if (!matchesFunc)
        return;
      const quality = $el.find("span").text();
      const regExpQuality = /(.+?) \((.+?)\)/;
      const matchesQuality = regExpQuality.exec(quality ?? "");
      if (!matchesQuality)
        return;
      dlDetails.push({
        parameters: [matchesFunc[1], matchesFunc[2], matchesFunc[3]],
        quality: {
          label: matchesQuality[1].trim(),
          size: matchesQuality[2]
        }
      });
    });
    ctx.progress(40);
    let dls = await Promise.all(
      dlDetails.map(async (dl) => {
        const query = {
          op: "download_orig",
          id: dl.parameters[0],
          mode: dl.parameters[1],
          hash: dl.parameters[2]
        };
        const getDownload = await ctx.proxiedFetcher(`/dl`, {
          query,
          baseUrl: parsedUrl.origin
        });
        const downloadDoc = load(getDownload);
        const recaptchaKey = downloadDoc(".g-recaptcha").attr("data-sitekey");
        if (!recaptchaKey)
          throw new Error("Unable to get captcha key");
        const captchaToken = await fetchCaptchaToken(ctx, parsedUrl.origin, recaptchaKey);
        if (!captchaToken)
          throw new Error("Unable to get captcha token");
        const dlForm = new FormData();
        dlForm.append("op", "download_orig");
        dlForm.append("id", dl.parameters[0]);
        dlForm.append("mode", dl.parameters[1]);
        dlForm.append("hash", dl.parameters[2]);
        dlForm.append("g-recaptcha-response", captchaToken);
        const download = await ctx.proxiedFetcher(`/dl`, {
          method: "POST",
          baseUrl: parsedUrl.origin,
          body: dlForm,
          query
        });
        const dlLink = load(download)(".btn.btn-light.btn-lg").attr("href");
        return {
          quality: dl.quality.label,
          url: dlLink
        };
      })
    );
    dls = dls.filter((d) => !!d.url);
    ctx.progress(80);
    const qualities = dls.reduce((a, v) => {
      a[v.quality] = {
        type: "mp4",
        url: v.url
      };
      return a;
    }, {});
    return {
      stream: [
        {
          id: "primary",
          type: "file",
          flags: [flags.CORS_ALLOWED],
          qualities,
          captions: []
        }
      ]
    };
  }
});
const origin$1 = "https://rabbitstream.net";
const referer$6 = "https://rabbitstream.net/";
const { AES, enc } = CryptoJS;
function isJSON(json) {
  try {
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
}

const upcloudScraper = makeEmbed({
  id: "upcloud",
  name: "UpCloud",
  rank: 200,
  async scrape(ctx) {
    const parsedUrl = new URL(ctx.url.replace("embed-5", "embed-4"));
    const dataPath = parsedUrl.pathname.split("/");
    const dataId = dataPath[dataPath.length - 1];
    const streamRes = await ctx.proxiedFetcher(`${parsedUrl.origin}/ajax/embed-4/getSources?id=${dataId}`, {
      headers: {
        Referer: parsedUrl.origin,
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    let sources = null;
    if (!isJSON(streamRes.sources)) {
      const decryptionKeyString = await ctx.proxiedFetcher(
        `https://raw.githubusercontent.com/eatmynerds/key/e4/key.txt`,
      );
      const decryptionKey = btoa(
        String.fromCharCode.apply(null, Array.from(new Uint8Array(JSON.parse(decryptionKeyString)))),
      );
      if (!decryptionKey) throw new Error('Key extraction failed');
      const decryptedStream = AES.decrypt(streamRes.sources, decryptionKey).toString(enc.Utf8);
      sources = isJSON(decryptedStream) ? JSON.parse(decryptedStream)[0] : streamRes.sources[0];
    }
    if (!sources)
      throw new Error("upcloud source not found");
    const captions = [];
    streamRes.tracks.forEach((track) => {
      if (track.kind !== "captions")
        return;
      const type = getCaptionTypeFromUrl(track.file);
      if (!type)
        return;
      const language = labelToLanguageCode(track.label.split(" ")[0]);
      if (!language)
        return;
      captions.push({
        id: track.file,
        language,
        hasCorsRestrictions: false,
        type,
        url: track.file
      });
    });
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: sources.file,
          flags: [flags.CORS_ALLOWED],
          captions,
          preferredHeaders: {
            Referer: referer$6,
            Origin: origin$1
          }
        }
      ]
    };
  }
});
const packedRegex = /(eval\(function\(p,a,c,k,e,d\).*\)\)\))/;
const linkRegex = /sources:\[{file:"(.*?)"/;
const upstreamScraper = makeEmbed({
  id: "upstream",
  name: "UpStream",
  rank: 199,
  async scrape(ctx) {
    const streamRes = await ctx.proxiedFetcher(ctx.url);
    const packed = streamRes.match(packedRegex);
    if (packed) {
      const unpacked = unpacker.unpack(packed[1]);
      const link = unpacked.match(linkRegex);
      if (link) {
        return {
          stream: [
            {
              id: "primary",
              type: "hls",
              playlist: link[1],
              flags: [flags.CORS_ALLOWED],
              captions: []
            }
          ]
        };
      }
    }
    throw new Error("upstream source not found");
  }
});
const hlsURLRegex = /file:"(.*?)"/;
const setPassRegex = /var pass_path = "(.*set_pass\.php.*)";/;
function formatHlsB64(data2) {
  const encodedB64 = data2.replace(/\/@#@\/[^=/]+==/g, "");
  if (encodedB64.match(/\/@#@\/[^=/]+==/)) {
    return formatHlsB64(encodedB64);
  }
  return encodedB64;
}
const vidsrcembedScraper = makeEmbed({
  id: "vidsrcembed",
  // VidSrc is both a source and an embed host
  name: "VidSrc",
  rank: 197,
  async scrape(ctx) {
    var _a, _b, _c;
    const html = await ctx.proxiedFetcher(ctx.url, {
      headers: {
        referer: ctx.url
      }
    });
    let hlsMatch = (_b = (_a = html.match(hlsURLRegex)) == null ? void 0 : _a[1]) == null ? void 0 : _b.slice(2);
    if (!hlsMatch)
      throw new Error("Unable to find HLS playlist");
    hlsMatch = formatHlsB64(hlsMatch);
    const finalUrl = atob(hlsMatch);
    if (!finalUrl.includes(".m3u8"))
      throw new Error("Unable to find HLS playlist");
    let setPassLink = (_c = html.match(setPassRegex)) == null ? void 0 : _c[1];
    if (!setPassLink)
      throw new Error("Unable to find set_pass.php link");
    if (setPassLink.startsWith("//")) {
      setPassLink = `https:${setPassLink}`;
    }
    await ctx.proxiedFetcher(setPassLink, {
      headers: {
        referer: ctx.url
      }
    });
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: finalUrl,
          flags: [flags.CORS_ALLOWED],
          captions: []
        }
      ]
    };
  }
});
const vidCloudScraper = makeEmbed({
  id: "vidcloud",
  name: "VidCloud",
  rank: 201,
  async scrape(ctx) {
    const result = await upcloudScraper.scrape(ctx);
    return {
      stream: result.stream.map((s) => ({
        ...s,
        flags: []
      }))
    };
  }
});
const flixHqBase = "https://flixhq.to";
async function getFlixhqSourceDetails(ctx, sourceId) {
  const jsonData = await ctx.proxiedFetcher(`/ajax/sources/${sourceId}`, {
    baseUrl: flixHqBase
  });
  return jsonData.link;
}
async function getFlixhqMovieSources(ctx, media, id) {
  const episodeParts = id.split("-");
  const episodeId = episodeParts[episodeParts.length - 1];
  const data2 = await ctx.proxiedFetcher(`/ajax/movie/episodes/${episodeId}`, {
    baseUrl: flixHqBase
  });
  const doc = load(data2);
  const sourceLinks = doc(".nav-item > a").toArray().map((el) => {
    const query = doc(el);
    const embedTitle = query.attr("title");
    const linkId = query.attr("data-linkid");
    if (!embedTitle || !linkId)
      throw new Error("invalid sources");
    return {
      embed: embedTitle,
      episodeId: linkId
    };
  });
  return sourceLinks;
}
async function getFlixhqShowSources(ctx, media, id) {
  var _a, _b;
  const episodeParts = id.split("-");
  const episodeId = episodeParts[episodeParts.length - 1];
  const seasonsListData = await ctx.proxiedFetcher(`/ajax/season/list/${episodeId}`, {
    baseUrl: flixHqBase
  });
  const seasonsDoc = load(seasonsListData);
  const season = (_a = seasonsDoc(".dropdown-item").toArray().find((el) => seasonsDoc(el).text() === `Season ${media.season.number}`)) == null ? void 0 : _a.attribs["data-id"];
  if (!season)
    throw new NotFoundError("season not found");
  const seasonData = await ctx.proxiedFetcher(`/ajax/season/episodes/${season}`, {
    baseUrl: flixHqBase
  });
  const seasonDoc = load(seasonData);
  const episode = (_b = seasonDoc(".nav-item > a").toArray().map((el) => {
    return {
      id: seasonDoc(el).attr("data-id"),
      title: seasonDoc(el).attr("title")
    };
  }).find((e) => {
    var _a2;
    return (_a2 = e.title) == null ? void 0 : _a2.startsWith(`Eps ${media.episode.number}`);
  })) == null ? void 0 : _b.id;
  if (!episode)
    throw new NotFoundError("episode not found");
  const data2 = await ctx.proxiedFetcher(`/ajax/episode/servers/${episode}`, {
    baseUrl: flixHqBase
  });
  const doc = load(data2);
  const sourceLinks = doc(".nav-item > a").toArray().map((el) => {
    const query = doc(el);
    const embedTitle = query.attr("title");
    const linkId = query.attr("data-id");
    if (!embedTitle || !linkId)
      throw new Error("invalid sources");
    return {
      embed: embedTitle,
      episodeId: linkId
    };
  });
  return sourceLinks;
}
function normalizeTitle(title) {
  return title.trim().toLowerCase().replace(/['":]/g, "").replace(/[^a-zA-Z0-9]+/g, "_");
}
function compareTitle(a, b) {
  return normalizeTitle(a) === normalizeTitle(b);
}
function compareMedia(media, title, releaseYear) {
  const isSameYear = releaseYear === void 0 ? true : media.releaseYear === releaseYear;
  return compareTitle(media.title, title) && isSameYear;
}
async function getFlixhqId(ctx, media) {
  const searchResults = await ctx.proxiedFetcher(`/search/${media.title.replaceAll(/[^a-z0-9A-Z]/g, "-")}`, {
    baseUrl: flixHqBase
  });
  const doc = load(searchResults);
  const items = doc(".film_list-wrap > div.flw-item").toArray().map((el) => {
    var _a;
    const query = doc(el);
    const id = (_a = query.find("div.film-poster > a").attr("href")) == null ? void 0 : _a.slice(1);
    const title = query.find("div.film-detail > h2 > a").attr("title");
    const year = query.find("div.film-detail > div.fd-infor > span:nth-child(1)").text();
    const seasons = year.includes("SS") ? year.split("SS")[1] : "0";
    if (!id || !title || !year)
      return null;
    return {
      id,
      title,
      year: parseInt(year, 10),
      seasons: parseInt(seasons, 10)
    };
  });
  const matchingItem = items.find((v) => {
    if (!v)
      return false;
    if (media.type === "movie") {
      return compareMedia(media, v.title, v.year);
    }
    return compareTitle(media.title, v.title) && media.season.number < v.seasons + 1;
  });
  if (!matchingItem)
    return null;
  return matchingItem.id;
}
const flixhqScraper = makeSourcerer({
  id: "flixhq",
  name: "FlixHQ",
  rank: 100,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  async scrapeMovie(ctx) {
    const id = await getFlixhqId(ctx, ctx.media);
    if (!id)
      throw new NotFoundError("no search results match");
    const sources = await getFlixhqMovieSources(ctx, ctx.media, id);
    const embeds = [];
    for (const source of sources) {
      if (source.embed.toLowerCase() === "upcloud") {
        embeds.push({
          embedId: upcloudScraper.id,
          url: await getFlixhqSourceDetails(ctx, source.episodeId)
        });
      } else if (source.embed.toLowerCase() === "vidcloud") {
        embeds.push({
          embedId: vidCloudScraper.id,
          url: await getFlixhqSourceDetails(ctx, source.episodeId)
        });
      }
    }
    return {
      embeds
    };
  },
  async scrapeShow(ctx) {
    const id = await getFlixhqId(ctx, ctx.media);
    if (!id)
      throw new NotFoundError("no search results match");
    const sources = await getFlixhqShowSources(ctx, ctx.media, id);
    const embeds = [];
    for (const source of sources) {
      if (source.embed.toLowerCase() === "server upcloud") {
        embeds.push({
          embedId: upcloudScraper.id,
          url: await getFlixhqSourceDetails(ctx, source.episodeId)
        });
      } else if (source.embed.toLowerCase() === "server vidcloud") {
        embeds.push({
          embedId: vidCloudScraper.id,
          url: await getFlixhqSourceDetails(ctx, source.episodeId)
        });
      }
    }
    return {
      embeds
    };
  }
});
async function getSource(ctx, sources) {
  const upcloud = load(sources)('a[title*="upcloud" i]');
  const upcloudDataId = (upcloud == null ? void 0 : upcloud.attr("data-id")) ?? (upcloud == null ? void 0 : upcloud.attr("data-linkid"));
  if (!upcloudDataId)
    throw new NotFoundError("Upcloud source not available");
  const upcloudSource = await ctx.proxiedFetcher(`/ajax/sources/${upcloudDataId}`, {
    headers: {
      "X-Requested-With": "XMLHttpRequest"
    },
    baseUrl: gomoviesBase
  });
  if (!upcloudSource.link || upcloudSource.type !== "iframe")
    throw new NotFoundError("No upcloud stream found");
  return upcloudSource;
}
const gomoviesBase = `https://gomovies.sx`;
const goMoviesScraper = makeSourcerer({
  id: "gomovies",
  name: "GOmovies",
  rank: 110,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  async scrapeShow(ctx) {
    var _a;
    const search2 = await ctx.proxiedFetcher(`/ajax/search`, {
      method: "POST",
      body: new URLSearchParams({ keyword: ctx.media.title }),
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      },
      baseUrl: gomoviesBase
    });
    const searchPage = load(search2);
    const mediaElements = searchPage("a.nav-item");
    const mediaData = mediaElements.toArray().map((movieEl) => {
      var _a2, _b;
      const name = (_a2 = searchPage(movieEl).find("h3.film-name")) == null ? void 0 : _a2.text();
      const year = (_b = searchPage(movieEl).find("div.film-infor span:first-of-type")) == null ? void 0 : _b.text();
      const path = searchPage(movieEl).attr("href");
      return { name, year, path };
    });
    const targetMedia = mediaData.find((m) => m.name === ctx.media.title);
    if (!(targetMedia == null ? void 0 : targetMedia.path))
      throw new NotFoundError("Media not found");
    let mediaId = (_a = targetMedia.path.split("-").pop()) == null ? void 0 : _a.replace("/", "");
    const seasons = await ctx.proxiedFetcher(`/ajax/v2/tv/seasons/${mediaId}`, {
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      },
      baseUrl: gomoviesBase
    });
    const seasonsEl = load(seasons)(".ss-item");
    const seasonsData = seasonsEl.toArray().map((season) => ({
      number: load(season).text().replace("Season ", ""),
      dataId: season.attribs["data-id"]
    }));
    const seasonNumber = ctx.media.season.number;
    const targetSeason = seasonsData.find((season) => +season.number === seasonNumber);
    if (!targetSeason)
      throw new NotFoundError("Season not found");
    const episodes = await ctx.proxiedFetcher(`/ajax/v2/season/episodes/${targetSeason.dataId}`, {
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      },
      baseUrl: gomoviesBase
    });
    const episodesPage = load(episodes);
    const episodesEl = episodesPage(".eps-item");
    const episodesData = episodesEl.toArray().map((ep) => ({
      dataId: ep.attribs["data-id"],
      number: episodesPage(ep).find("strong").text().replace("Eps", "").replace(":", "").trim()
    }));
    const episodeNumber = ctx.media.episode.number;
    const targetEpisode = episodesData.find((ep) => ep.number ? +ep.number === episodeNumber : false);
    if (!(targetEpisode == null ? void 0 : targetEpisode.dataId))
      throw new NotFoundError("Episode not found");
    mediaId = targetEpisode.dataId;
    const sources = await ctx.proxiedFetcher(`ajax/v2/episode/servers/${mediaId}`, {
      baseUrl: gomoviesBase,
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    const upcloudSource = await getSource(ctx, sources);
    return {
      embeds: [
        {
          embedId: upcloudScraper.id,
          url: upcloudSource.link
        }
      ]
    };
  },
  async scrapeMovie(ctx) {
    var _a;
    const search2 = await ctx.proxiedFetcher(`/search/${ctx.media.title.replace(' ', '-')}`, {
      method: "GET",
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      },
      baseUrl: gomoviesBase
    });
    const searchPage = load(search2);
    const mediaElements = searchPage("div.film-detail");
    const mediaData = mediaElements.toArray().map((movieEl) => {
      var _a2, _b;
      const name = (_a2 = searchPage(movieEl).find("h2.film-name a")) == null ? void 0 : _a2.text();
      const year = (_b = searchPage(movieEl).find("span.fdi-item:first")) == null ? void 0 : _b.text();
      const path = searchPage(movieEl).find("h2.film-name a").attr("href");
      return { name, year, path };
    });

    const targetMedia = mediaData.find(
      (m) => m.name === ctx.media.title && m.year === ctx.media.releaseYear.toString()
    );
    if (!(targetMedia == null ? void 0 : targetMedia.path))
      throw new NotFoundError("Media not found");
    const mediaId = (_a = targetMedia.path.split("-").pop()) == null ? void 0 : _a.replace("/", "");
    const sources = await ctx.proxiedFetcher(`ajax/movie/episodes/${mediaId}`, {
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      },
      baseUrl: gomoviesBase
    });
    const upcloudSource = await getSource(ctx, sources);
    return {
      embeds: [
        {
          embedId: upcloudScraper.id,
          url: upcloudSource.link
        }
      ]
    };
  }
});
const kissasianBase = "https://kissasian.sh";
const embedProviders = [
  {
    type: mp4uploadScraper.id,
    id: "mp"
  },
  {
    type: streamsbScraper.id,
    id: "sb"
  }
];
async function getEmbeds$1(ctx, targetEpisode) {
  let embeds = await Promise.all(
    embedProviders.map(async (provider) => {
      if (!targetEpisode.url)
        throw new NotFoundError("Episode not found");
      const watch = await ctx.proxiedFetcher(`${targetEpisode.url}&s=${provider.id}`, {
        baseUrl: kissasianBase,
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache",
          pragma: "no-cache",
          "sec-ch-ua": '"Not)A;Brand";v="24", "Chromium";v="116"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "cross-site",
          "sec-fetch-user": "?1",
          "upgrade-insecure-requests": "1",
          cookie: "__rd=; ASP.NET_SessionId=jwnl2kmlw5h4mfdaxvpk30q0; k_token=OKbJDFNx3rUtaw7iAA6UxMKSJb79lgZ2X2rVC9aupJhycYQKVSLaW1y2B4K%2f%2fo3i6BuzhXgfkJGmKlKH6LpNlKPPpZUk31n9DapfMdJgjlLExgrPS3jpSKwGnNUI%2bOpNpZu9%2fFnkLZRxvVKCa8APMxrck1tYkKXWqfyJJh8%2b7hQTI1wfAOU%2fLEouHhtQGL%2fReTzElw2LQ0XSL1pjs%2fkWW3rM3of2je7Oo13I%2f7olLFuiJUVWyNbn%2fYKSgNrm%2bQ3p"
        }
      });
      const watchPage = load(watch);
      const embedUrl = watchPage("#my_video_1").attr("src");
      if (!embedUrl)
        throw new Error("Embed not found");
      return {
        embedId: provider.id,
        url: embedUrl
      };
    })
  );
  embeds = embeds.filter((e) => !!e.url);
  return embeds;
}
function getEpisodes(dramaPage) {
  const episodesEl = dramaPage(".episodeSub");
  return episodesEl.toArray().map((ep) => {
    var _a;
    const number = (_a = dramaPage(ep).find(".episodeSub a").text().split("Episode")[1]) == null ? void 0 : _a.trim();
    const url = dramaPage(ep).find(".episodeSub a").attr("href");
    return { number, url };
  }).filter((e) => !!e.url);
}
async function search(ctx, title, seasonNumber) {
  const searchForm = new FormData();
  searchForm.append("keyword", `${title} ${seasonNumber ?? ""}`.trim());
  searchForm.append("type", "Drama");
  const searchResults = await ctx.proxiedFetcher("/Search/SearchSuggest", {
    baseUrl: kissasianBase,
    method: "POST",
    body: searchForm
  });
  const searchPage = load(searchResults);
  return Array.from(searchPage("a")).map((drama) => {
    return {
      name: searchPage(drama).text(),
      url: drama.attribs.href
    };
  });
}
const kissAsianScraper = makeSourcerer({
  id: "kissasian",
  name: "KissAsian",
  rank: 130,
  flags: [flags.CORS_ALLOWED],
  disabled: true,
  async scrapeShow(ctx) {
    const seasonNumber = ctx.media.season.number;
    const episodeNumber = ctx.media.episode.number;
    const dramas = await search(ctx, ctx.media.title, seasonNumber);
    const targetDrama = dramas.find((d) => {
      var _a;
      return ((_a = d.name) == null ? void 0 : _a.toLowerCase()) === ctx.media.title.toLowerCase();
    }) ?? dramas[0];
    if (!targetDrama)
      throw new NotFoundError("Drama not found");
    ctx.progress(30);
    const drama = await ctx.proxiedFetcher(targetDrama.url, {
      baseUrl: kissasianBase
    });
    const dramaPage = load(drama);
    const episodes = await getEpisodes(dramaPage);
    const targetEpisode = episodes.find((e) => e.number === `${episodeNumber}`);
    if (!(targetEpisode == null ? void 0 : targetEpisode.url))
      throw new NotFoundError("Episode not found");
    ctx.progress(70);
    const embeds = await getEmbeds$1(ctx, targetEpisode);
    return {
      embeds
    };
  },
  async scrapeMovie(ctx) {
    const dramas = await search(ctx, ctx.media.title, void 0);
    const targetDrama = dramas.find((d) => {
      var _a;
      return ((_a = d.name) == null ? void 0 : _a.toLowerCase()) === ctx.media.title.toLowerCase();
    }) ?? dramas[0];
    if (!targetDrama)
      throw new NotFoundError("Drama not found");
    ctx.progress(30);
    const drama = await ctx.proxiedFetcher(targetDrama.url, {
      baseUrl: kissasianBase
    });
    const dramaPage = load(drama);
    const episodes = getEpisodes(dramaPage);
    const targetEpisode = episodes[0];
    if (!(targetEpisode == null ? void 0 : targetEpisode.url))
      throw new NotFoundError("Episode not found");
    ctx.progress(70);
    const embeds = await getEmbeds$1(ctx, targetEpisode);
    return {
      embeds
    };
  }
});
async function getVideoSources(ctx, id, media) {
  let path = "";
  if (media.type === "show") {
    path = `/v1/episodes/view`;
  } else if (media.type === "movie") {
    path = `/v1/movies/view`;
  }
  const data2 = await ctx.fetcher(path, {
    baseUrl: baseUrl$1,
    query: { expand: "streams,subtitles", id }
  });
  return data2;
}
async function getVideo(ctx, id, media) {
  const data2 = await getVideoSources(ctx, id, media);
  const videoSources = data2.streams;
  const opts = ["auto", "1080p", "1080", "720p", "720", "480p", "480", "240p", "240", "360p", "360", "144", "144p"];
  let videoUrl = null;
  for (const res of opts) {
    if (videoSources[res] && !videoUrl) {
      videoUrl = videoSources[res];
    }
  }
  let captions = [];
  for (const sub of data2.subtitles) {
    const language = labelToLanguageCode(sub.language);
    if (!language)
      continue;
    captions.push({
      id: sub.url,
      type: "vtt",
      url: `${baseUrl$1}${sub.url}`,
      hasCorsRestrictions: false,
      language
    });
  }
  captions = removeDuplicatedLanguages(captions);
  return {
    playlist: videoUrl,
    captions
  };
}
const baseUrl$1 = "https://lmscript.xyz";
async function searchAndFindMedia$1(ctx, media) {
  if (media.type === "show") {
    const searchRes = await ctx.fetcher(`/v1/shows`, {
      baseUrl: baseUrl$1,
      query: { "filters[q]": media.title }
    });
    const results = searchRes.items;
    const result = results.find((res) => compareMedia(media, res.title, Number(res.year)));
    return result;
  }
  if (media.type === "movie") {
    const searchRes = await ctx.fetcher(`/v1/movies`, {
      baseUrl: baseUrl$1,
      query: { "filters[q]": media.title }
    });
    const results = searchRes.items;
    const result = results.find((res) => compareMedia(media, res.title, Number(res.year)));
    return result;
  }
}
async function scrape(ctx, media, result) {
  var _a;
  let id = null;
  if (media.type === "movie") {
    id = result.id_movie;
  } else if (media.type === "show") {
    const data2 = await ctx.fetcher(`/v1/shows`, {
      baseUrl: baseUrl$1,
      query: { expand: "episodes", id: result.id_show }
    });
    const episode = (_a = data2.episodes) == null ? void 0 : _a.find((v) => {
      return Number(v.season) === Number(media.season.number) && Number(v.episode) === Number(media.episode.number);
    });
    if (episode)
      id = episode.id;
  }
  if (id === null)
    throw new NotFoundError("Not found");
  const video = await getVideo(ctx, id, media);
  return video;
}
async function universalScraper$5(ctx) {
  const lookmovieData = await searchAndFindMedia$1(ctx, ctx.media);
  if (!lookmovieData)
    throw new NotFoundError("Media not found");
  ctx.progress(30);
  const video = await scrape(ctx, ctx.media, lookmovieData);
  if (!video.playlist)
    throw new NotFoundError("No video found");
  ctx.progress(60);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        playlist: video.playlist,
        type: "hls",
        flags: [flags.IP_LOCKED],
        captions: video.captions
      }
    ]
  };
}
const lookmovieScraper = makeSourcerer({
  id: "lookmovie",
  name: "LookMovie",
  disabled: true,
  rank: 700,
  flags: [flags.IP_LOCKED],
  scrapeShow: universalScraper$5,
  scrapeMovie: universalScraper$5
});
const remotestreamBase = atob("aHR0cHM6Ly9mc2IuOG1ldDNkdGpmcmNxY2hjb25xcGtsd3hzeGIyb2N1bWMuc3RyZWFt");
const origin = "https://remotestre.am";
const referer$5 = "https://remotestre.am/";
const remotestreamScraper = makeSourcerer({
  id: "remotestream",
  name: "Remote Stream",
  disabled: true,
  rank: 55,
  flags: [flags.CORS_ALLOWED],
  async scrapeShow(ctx) {
    var _a;
    const seasonNumber = ctx.media.season.number;
    const episodeNumber = ctx.media.episode.number;
    const playlistLink = `${remotestreamBase}/Shows/${ctx.media.tmdbId}/${seasonNumber}/${episodeNumber}/${episodeNumber}.m3u8`;
    ctx.progress(30);
    const streamRes = await ctx.proxiedFetcher.full(playlistLink, {
      method: "GET",
      readHeaders: ["content-type"],
      headers: {
        Referer: referer$5
      }
    });
    if (!((_a = streamRes.headers.get("content-type")) == null ? void 0 : _a.toLowerCase().includes("application/x-mpegurl")))
      throw new NotFoundError("No watchable item found");
    ctx.progress(90);
    return {
      embeds: [],
      stream: [
        {
          id: "primary",
          captions: [],
          playlist: playlistLink,
          type: "hls",
          flags: [flags.CORS_ALLOWED],
          preferredHeaders: {
            Referer: referer$5,
            Origin: origin
          }
        }
      ]
    };
  },
  async scrapeMovie(ctx) {
    var _a;
    const playlistLink = `${remotestreamBase}/Movies/${ctx.media.tmdbId}/${ctx.media.tmdbId}.m3u8`;
    ctx.progress(30);
    const streamRes = await ctx.proxiedFetcher.full(playlistLink, {
      method: "GET",
      readHeaders: ["content-type"],
      headers: {
        Referer: referer$5
      }
    });
    if (!((_a = streamRes.headers.get("content-type")) == null ? void 0 : _a.toLowerCase().includes("application/x-mpegurl")))
      throw new NotFoundError("No watchable item found");
    ctx.progress(90);
    return {
      embeds: [],
      stream: [
        {
          id: "primary",
          captions: [],
          playlist: playlistLink,
          type: "hls",
          flags: [flags.CORS_ALLOWED],
          preferredHeaders: {
            Referer: referer$5,
            Origin: origin
          }
        }
      ]
    };
  }
});
async function comboScraper(ctx) {
  const searchQuery = {
    module: "Search4",
    page: "1",
    type: "all",
    keyword: ctx.media.title,
    pagelimit: "20"
  };
  const searchRes = (await sendRequest(ctx, searchQuery, true)).data.list;
  ctx.progress(50);
  const showboxEntry = searchRes.find(
    (res) => compareTitle(res.title, ctx.media.title) && res.year === Number(ctx.media.releaseYear)
  );
  if (!showboxEntry)
    throw new NotFoundError("No entry found");
  const id = showboxEntry.id;
  const season = ctx.media.type === "show" ? ctx.media.season.number : "";
  const episode = ctx.media.type === "show" ? ctx.media.episode.number : "";
  return {
    embeds: [
      {
        embedId: febboxMp4Scraper.id,
        url: `/${ctx.media.type}/${id}/${season}/${episode}`
      }
    ]
  };
}
const showboxScraper = makeSourcerer({
  id: "showbox",
  name: "Showbox",
  rank: 400,
  flags: [flags.CORS_ALLOWED, flags.CF_BLOCKED],
  scrapeShow: comboScraper,
  scrapeMovie: comboScraper
});
const vidsrcBase = "https://vidsrc.me";
const vidsrcRCPBase = "https://rcp.vidsrc.me";
function decodeSrc(encoded, seed) {
  let decoded = "";
  const seedLength = seed.length;
  for (let i = 0; i < encoded.length; i += 2) {
    const byte = parseInt(encoded.substr(i, 2), 16);
    const seedChar = seed.charCodeAt(i / 2 % seedLength);
    decoded += String.fromCharCode(byte ^ seedChar);
  }
  return decoded;
}
async function getVidSrcEmbeds(ctx, startingURL) {
  const embeds = [];
  let html = await ctx.proxiedFetcher(startingURL, {
    baseUrl: vidsrcBase
  });
  let $ = load(html);
  const sourceHashes = $(".server[data-hash]").toArray().map((el) => $(el).attr("data-hash")).filter((hash) => hash !== void 0);
  for (const hash of sourceHashes) {
    html = await ctx.proxiedFetcher(`/rcp/${hash}`, {
      baseUrl: vidsrcRCPBase,
      headers: {
        referer: vidsrcBase
      }
    });
    $ = load(html);
    const encoded = $("#hidden").attr("data-h");
    const seed = $("body").attr("data-i");
    if (!encoded || !seed) {
      throw new Error("Failed to find encoded iframe src");
    }
    let redirectURL = decodeSrc(encoded, seed);
    if (redirectURL.startsWith("//")) {
      redirectURL = `https:${redirectURL}`;
    }
    const { finalUrl } = await ctx.proxiedFetcher.full(redirectURL, {
      method: "HEAD",
      headers: {
        referer: vidsrcBase
      }
    });
    const embed = {
      embedId: "",
      url: finalUrl
    };
    const parsedUrl = new URL(finalUrl);
    switch (parsedUrl.host) {
      case "vidsrc.stream":
        embed.embedId = vidsrcembedScraper.id;
        break;
      case "streambucket.net":
        embed.embedId = streambucketScraper.id;
        break;
      case "2embed.cc":
      case "www.2embed.cc":
        break;
      case "player-cdn.com":
        break;
      default:
        throw new Error(`Failed to find VidSrc embed source for ${finalUrl}`);
    }
    if (embed.embedId !== "") {
      embeds.push(embed);
    }
  }
  return embeds;
}
async function getVidSrcMovieSources(ctx) {
  return getVidSrcEmbeds(ctx, `/embed/${ctx.media.tmdbId}`);
}
async function getVidSrcShowSources(ctx) {
  const html = await ctx.proxiedFetcher(`/embed/${ctx.media.tmdbId}`, {
    baseUrl: vidsrcBase
  });
  const $ = load(html);
  const episodeElement = $(`.ep[data-s="${ctx.media.season.number}"][data-e="${ctx.media.episode.number}"]`).first();
  if (episodeElement.length === 0) {
    throw new Error("failed to find episode element");
  }
  const startingURL = episodeElement.attr("data-iframe");
  if (!startingURL) {
    throw new Error("failed to find episode starting URL");
  }
  return getVidSrcEmbeds(ctx, startingURL);
}
async function scrapeMovie$1(ctx) {
  return {
    embeds: await getVidSrcMovieSources(ctx)
  };
}
async function scrapeShow$1(ctx) {
  return {
    embeds: await getVidSrcShowSources(ctx)
  };
}
const vidsrcScraper = makeSourcerer({
  id: "vidsrc",
  name: "VidSrc",
  rank: 350,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: scrapeMovie$1,
  scrapeShow: scrapeShow$1
});
async function getZoeChipSources(ctx, id) {
  const endpoint = ctx.media.type === "movie" ? "list" : "servers";
  const html = await ctx.proxiedFetcher(`/ajax/episode/${endpoint}/${id}`, {
    baseUrl: zoeBase
  });
  const $ = load(html);
  return $(".nav-item a").toArray().map((el) => {
    const idAttribute = ctx.media.type === "movie" ? "data-linkid" : "data-id";
    const element = $(el);
    const embedTitle = element.attr("title");
    const linkId = element.attr(idAttribute);
    if (!embedTitle || !linkId) {
      throw new Error("invalid sources");
    }
    return {
      embed: embedTitle,
      episodeId: linkId
    };
  });
}
async function getZoeChipSourceURL(ctx, sourceID) {
  const details = await ctx.proxiedFetcher(`/ajax/sources/${sourceID}`, {
    baseUrl: zoeBase
  });
  if (details.type !== "iframe") {
    return null;
  }
  return details.link;
}
async function getZoeChipSeasonID(ctx, media, showID) {
  const html = await ctx.proxiedFetcher(`/ajax/season/list/${showID}`, {
    baseUrl: zoeBase
  });
  const $ = load(html);
  const seasons = $(".dropdown-menu a").toArray().map((el) => {
    var _a;
    const element = $(el);
    const seasonID = element.attr("data-id");
    const seasonNumber = (_a = element.html()) == null ? void 0 : _a.split(" ")[1];
    if (!seasonID || !seasonNumber || Number.isNaN(Number(seasonNumber))) {
      throw new Error("invalid season");
    }
    return {
      id: seasonID,
      season: Number(seasonNumber)
    };
  });
  const foundSeason = seasons.find((season) => season.season === media.season.number);
  if (!foundSeason) {
    return null;
  }
  return foundSeason.id;
}
async function getZoeChipEpisodeID(ctx, media, seasonID) {
  const episodeNumberRegex = /Eps (\d*):/;
  const html = await ctx.proxiedFetcher(`/ajax/season/episodes/${seasonID}`, {
    baseUrl: zoeBase
  });
  const $ = load(html);
  const episodes = $(".eps-item").toArray().map((el) => {
    const element = $(el);
    const episodeID = element.attr("data-id");
    const title = element.attr("title");
    if (!episodeID || !title) {
      throw new Error("invalid episode");
    }
    const regexResult = title.match(episodeNumberRegex);
    if (!regexResult || Number.isNaN(Number(regexResult[1]))) {
      throw new Error("invalid episode");
    }
    return {
      id: episodeID,
      episode: Number(regexResult[1])
    };
  });
  const foundEpisode = episodes.find((episode) => episode.episode === media.episode.number);
  if (!foundEpisode) {
    return null;
  }
  return foundEpisode.id;
}
const zoeBase = "https://zoechip.cc";
async function formatSource(ctx, source) {
  const link = await getZoeChipSourceURL(ctx, source.episodeId);
  if (link) {
    const embed = {
      embedId: "",
      url: link
    };
    const parsedUrl = new URL(link);
    switch (parsedUrl.host) {
      case "rabbitstream.net":
        embed.embedId = upcloudScraper.id;
        break;
      case "upstream.to":
        embed.embedId = upstreamScraper.id;
        break;
      case "mixdrop.co":
        embed.embedId = mixdropScraper.id;
        break;
      default:
        return null;
    }
    return embed;
  }
}
async function createZoeChipStreamData(ctx, id) {
  const sources = await getZoeChipSources(ctx, id);
  const embeds = [];
  for (const source of sources) {
    const formatted = await formatSource(ctx, source);
    if (formatted) {
      const upCloudAlreadyExists = embeds.find((e) => e.embedId === upcloudScraper.id);
      if (formatted.embedId === upcloudScraper.id && upCloudAlreadyExists) {
        formatted.embedId = vidCloudScraper.id;
      }
      embeds.push(formatted);
    }
  }
  return {
    embeds
  };
}
async function getZoeChipSearchResults(ctx, media) {
  const titleCleaned = media.title.toLocaleLowerCase().replace(/ /g, "-");
  const html = await ctx.proxiedFetcher(`/search/${titleCleaned}`, {
    baseUrl: zoeBase
  });
  const $ = load(html);
  return $(".film_list-wrap .flw-item .film-detail").toArray().map((element) => {
    const movie = $(element);
    const anchor = movie.find(".film-name a");
    const info = movie.find(".fd-infor");
    const title = anchor.attr("title");
    const href = anchor.attr("href");
    const type = info.find(".fdi-type").html();
    let year = info.find(".fdi-item").html();
    const id = href == null ? void 0 : href.split("-").pop();
    if (!title) {
      return null;
    }
    if (!href) {
      return null;
    }
    if (!type) {
      return null;
    }
    if (!year || Number.isNaN(Number(year))) {
      if (type === "TV") {
        year = "0";
      } else {
        return null;
      }
    }
    if (!id) {
      return null;
    }
    return {
      title,
      year: Number(year),
      id,
      type,
      href
    };
  });
}
async function getZoeChipMovieID(ctx, media) {
  const searchResults = await getZoeChipSearchResults(ctx, media);
  const matchingItem = searchResults.find((v) => v && v.type === "Movie" && compareMedia(media, v.title, v.year));
  if (!matchingItem) {
    return null;
  }
  return matchingItem.id;
}
async function getZoeChipShowID(ctx, media) {
  const releasedRegex = /<\/strong><\/span> (\d.*)-\d.*-\d.*/;
  const searchResults = await getZoeChipSearchResults(ctx, media);
  const filtered = searchResults.filter((v) => v && v.type === "TV" && compareMedia(media, v.title));
  for (const result of filtered) {
    if (!result) {
      continue;
    }
    const html = await ctx.proxiedFetcher(result.href, {
      baseUrl: zoeBase
    });
    const regexResult = html.match(releasedRegex);
    if (regexResult) {
      const year = Number(regexResult[1]);
      if (!Number.isNaN(year) && compareMedia(media, result.title, year)) {
        return result.id;
      }
    }
  }
  return null;
}
async function scrapeMovie(ctx) {
  const movieID = await getZoeChipMovieID(ctx, ctx.media);
  if (!movieID) {
    throw new NotFoundError("no search results match");
  }
  return createZoeChipStreamData(ctx, movieID);
}
async function scrapeShow(ctx) {
  const showID = await getZoeChipShowID(ctx, ctx.media);
  if (!showID) {
    throw new NotFoundError("no search results match");
  }
  const seasonID = await getZoeChipSeasonID(ctx, ctx.media, showID);
  if (!seasonID) {
    throw new NotFoundError("no season found");
  }
  const episodeID = await getZoeChipEpisodeID(ctx, ctx.media, seasonID);
  if (!episodeID) {
    throw new NotFoundError("no episode found");
  }
  return createZoeChipStreamData(ctx, episodeID);
}
const zoechipScraper = makeSourcerer({
  id: "zoechip",
  name: "ZoeChip",
  rank: 200,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie,
  scrapeShow
});
const referer$4 = "https://ridomovies.tv/";
const closeLoadScraper = makeEmbed({
  id: "closeload",
  name: "CloseLoad",
  rank: 106,
  async scrape(ctx) {
    var _a;
    const baseUrl3 = new URL(ctx.url).origin;
    const iframeRes = await ctx.proxiedFetcher(ctx.url, {
      headers: { referer: referer$4 }
    });
    const iframeRes$ = load(iframeRes);
    const captions = iframeRes$("track").map((_, el) => {
      const track = iframeRes$(el);
      const url2 = `${baseUrl3}${track.attr("src")}`;
      const label = track.attr("label") ?? "";
      const language = labelToLanguageCode(label);
      const captionType = getCaptionTypeFromUrl(url2);
      if (!language || !captionType)
        return null;
      return {
        id: url2,
        language,
        hasCorsRestrictions: true,
        type: captionType,
        url: url2
      };
    }).get().filter((x) => x !== null);
    const evalCode = iframeRes$("script").filter((_, el) => {
      var _a2;
      const script = iframeRes$(el);
      return (script.attr("type") === "text/javascript" && ((_a2 = script.html()) == null ? void 0 : _a2.includes("p,a,c,k,e,d"))) ?? false;
    }).html();
    if (!evalCode)
      throw new Error("Couldn't find eval code");
    const decoded = unpack(evalCode);
    const regexPattern = /var\s+(\w+)\s*=\s*"([^"]+)";/g;
    const base64EncodedUrl = (_a = regexPattern.exec(decoded)) == null ? void 0 : _a[2];
    if (!base64EncodedUrl)
      throw new NotFoundError("Unable to find source url");
    const url = atob(base64EncodedUrl);
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: url,
          captions,
          flags: [flags.IP_LOCKED],
          headers: {
            Referer: "https://closeload.top/",
            Origin: "https://closeload.top"
          }
        }
      ]
    };
  }
});
const evalCodeRegex = /eval\((.*)\)/g;
const fileRegex = /file:"(.*?)"/g;
const fileMoonScraper = makeEmbed({
  id: "filemoon",
  name: "Filemoon",
  rank: 400,
  scrape: async (ctx) => {
    const embedRes = await ctx.proxiedFetcher(ctx.url, {
      headers: {
        referer: ctx.url
      }
    });
    const evalCode = evalCodeRegex.exec(embedRes);
    if (!evalCode)
      throw new Error("Failed to find eval code");
    const unpacked = unpack(evalCode[1]);
    const file = fileRegex.exec(unpacked);
    if (!(file == null ? void 0 : file[1]))
      throw new Error("Failed to find file");
    const url = new URL(ctx.url);
    const subtitlesLink = url.searchParams.get("sub.info");
    const captions = [];
    if (subtitlesLink) {
      const captionsResult = await ctx.proxiedFetcher(subtitlesLink);
      for (const caption of captionsResult) {
        const language = labelToLanguageCode(caption.label);
        const captionType = getCaptionTypeFromUrl(caption.file);
        if (!language || !captionType)
          continue;
        captions.push({
          id: caption.file,
          url: caption.file,
          type: captionType,
          language,
          hasCorsRestrictions: false
        });
      }
    }
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: file[1],
          flags: [],
          captions
        }
      ]
    };
  }
});
const referer$3 = "https://ridomovies.tv/";
const ridooScraper = makeEmbed({
  id: "ridoo",
  name: "Ridoo",
  rank: 105,
  async scrape(ctx) {
    var _a;
    const res = await ctx.proxiedFetcher(ctx.url, {
      headers: {
        referer: referer$3
      }
    });
    const regexPattern = /file:"([^"]+)"/g;
    const url = (_a = regexPattern.exec(res)) == null ? void 0 : _a[1];
    if (!url)
      throw new NotFoundError("Unable to find source url");
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: url,
          captions: [],
          flags: [flags.CORS_ALLOWED]
        }
      ]
    };
  }
});
const smashyStreamDScraper = makeEmbed({
  id: "smashystream-d",
  name: "SmashyStream (D)",
  rank: 71,
  async scrape(ctx) {
    var _a, _b, _c;
    const mainPageRes = await ctx.proxiedFetcher(ctx.url, {
      headers: {
        Referer: ctx.url
      }
    });
    const mainPageRes$ = load(mainPageRes);
    const iframeUrl = mainPageRes$("iframe").attr("src");
    if (!iframeUrl)
      throw new Error(`[${this.name}] failed to find iframe url`);
    const mainUrl = new URL(iframeUrl);
    const iframeRes = await ctx.proxiedFetcher(iframeUrl, {
      headers: {
        Referer: ctx.url
      }
    });
    const textFilePath = (_a = iframeRes.match(/"file":"([^"]+)"/)) == null ? void 0 : _a[1];
    const csrfToken = (_b = iframeRes.match(/"key":"([^"]+)"/)) == null ? void 0 : _b[1];
    if (!textFilePath || !csrfToken)
      throw new Error(`[${this.name}] failed to find text file url or token`);
    const textFileUrl = `${mainUrl.origin}${textFilePath}`;
    const textFileRes = await ctx.proxiedFetcher(textFileUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRF-TOKEN": csrfToken,
        Referer: iframeUrl
      }
    });
    const textFilePlaylist = (_c = textFileRes.find((x) => x.title === "English")) == null ? void 0 : _c.file;
    if (!textFilePlaylist)
      throw new Error(`[${this.name}] failed to find an english playlist`);
    const playlistRes = await ctx.proxiedFetcher(
      `${mainUrl.origin}/playlist/${textFilePlaylist.slice(1)}.txt`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRF-TOKEN": csrfToken,
          Referer: iframeUrl
        }
      }
    );
    return {
      stream: [
        {
          id: "primary",
          playlist: playlistRes,
          type: "hls",
          flags: [flags.CORS_ALLOWED],
          captions: []
        }
      ]
    };
  }
});
const smashyStreamFScraper = makeEmbed({
  id: "smashystream-f",
  name: "SmashyStream (F)",
  rank: 70,
  async scrape(ctx) {
    var _a;
    const res = await ctx.proxiedFetcher(ctx.url, {
      headers: {
        Referer: ctx.url
      }
    });
    const captions = ((_a = res.subtitleUrls.match(/\[([^\]]+)\](https?:\/\/\S+?)(?=,\[|$)/g)) == null ? void 0 : _a.map((entry) => {
      const match = entry.match(/\[([^\]]+)\](https?:\/\/\S+?)(?=,\[|$)/);
      if (match) {
        const [, language, url] = match;
        if (language && url) {
          const languageCode = labelToLanguageCode(language);
          const captionType = getCaptionTypeFromUrl(url);
          if (!languageCode || !captionType)
            return null;
          return {
            id: url,
            url: url.replace(",", ""),
            language: languageCode,
            type: captionType,
            hasCorsRestrictions: false
          };
        }
      }
      return null;
    }).filter((x) => x !== null)) ?? [];
    return {
      stream: [
        {
          id: "primary",
          playlist: res.sourceUrls[0],
          type: "hls",
          flags: [flags.CORS_ALLOWED],
          captions
        }
      ]
    };
  }
});
const DECRYPTION_KEY = "8z5Ag5wgagfsOuhz";
const decodeBase64UrlSafe = (str) => {
  const standardizedInput = str.replace(/_/g, "/").replace(/-/g, "+");
  const decodedData = atob(standardizedInput);
  const bytes = new Uint8Array(decodedData.length);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = decodedData.charCodeAt(i);
  }
  return bytes;
};
const decodeData = (key2, data2) => {
  const state = Array.from(Array(256).keys());
  let index1 = 0;
  for (let i = 0; i < 256; i += 1) {
    index1 = (index1 + state[i] + key2.charCodeAt(i % key2.length)) % 256;
    const temp = state[i];
    state[i] = state[index1];
    state[index1] = temp;
  }
  index1 = 0;
  let index2 = 0;
  let finalKey = "";
  for (let char = 0; char < data2.length; char += 1) {
    index1 = (index1 + 1) % 256;
    index2 = (index2 + state[index1]) % 256;
    const temp = state[index1];
    state[index1] = state[index2];
    state[index2] = temp;
    if (typeof data2[char] === "string") {
      finalKey += String.fromCharCode(data2[char].charCodeAt(0) ^ state[(state[index1] + state[index2]) % 256]);
    } else if (typeof data2[char] === "number") {
      finalKey += String.fromCharCode(data2[char] ^ state[(state[index1] + state[index2]) % 256]);
    }
  }
  return finalKey;
};
const decryptSourceUrl = (sourceUrl) => {
  const encoded = decodeBase64UrlSafe(sourceUrl);
  const decoded = decodeData(DECRYPTION_KEY, encoded);
  return decodeURIComponent(decodeURIComponent(decoded));
};
const vidplayBase = "https://vidplay.online";
const referer$2 = `${vidplayBase}/`;
const getDecryptionKeys = async (ctx) => {
  var _a;
  const res = await ctx.proxiedFetcher("https://github.com/Ciarands/vidsrc-keys/blob/main/keys.json");
  const regex = /"rawLines":\s*\[([\s\S]*?)\]/;
  const rawLines = (_a = res.match(regex)) == null ? void 0 : _a[1];
  if (!rawLines)
    throw new Error("No keys found");
  const keys = JSON.parse(`${rawLines.substring(1).replace(/\\"/g, '"')}]`);
  return keys;
};
const getEncodedId = async (ctx) => {
  const url = new URL(ctx.url);
  const id = url.pathname.replace("/e/", "");
  const keyList = await getDecryptionKeys(ctx);
  const decodedId = decodeData(keyList[0], id);
  const encodedResult = decodeData(keyList[1], decodedId);
  const b64encoded = btoa(encodedResult);
  return b64encoded.replace("/", "_");
};
const getFuTokenKey = async (ctx) => {
  var _a;
  const id = await getEncodedId(ctx);
  const fuTokenRes = await ctx.proxiedFetcher("/futoken", {
    baseUrl: vidplayBase,
    headers: {
      referer: ctx.url
    }
  });
  const fuKey = (_a = fuTokenRes.match(/var\s+k\s*=\s*'([^']+)'/)) == null ? void 0 : _a[1];
  if (!fuKey)
    throw new Error("No fuKey found");
  const tokens = [];
  for (let i = 0; i < id.length; i += 1) {
    tokens.push(fuKey.charCodeAt(i % fuKey.length) + id.charCodeAt(i));
  }
  return `${fuKey},${tokens.join(",")}`;
};
const getFileUrl = async (ctx) => {
  const fuToken = await getFuTokenKey(ctx);
  return makeFullUrl(`/mediainfo/${fuToken}`, {
    baseUrl: vidplayBase,
    query: {
      ...Object.fromEntries(new URL(ctx.url).searchParams.entries()),
      autostart: "true"
    }
  });
};
const vidplayScraper = makeEmbed({
  id: "vidplay",
  name: "VidPlay",
  rank: 401,
  scrape: async (ctx) => {
    const fileUrl = await getFileUrl(ctx);
    const fileUrlRes = await ctx.proxiedFetcher(fileUrl, {
      headers: {
        referer: ctx.url
      }
    });
    if (typeof fileUrlRes.result === "number")
      throw new Error("File not found");
    const source = fileUrlRes.result.sources[0].file;
    const url = new URL(ctx.url);
    const subtitlesLink = url.searchParams.get("sub.info");
    const captions = [];
    if (subtitlesLink) {
      const captionsResult = await ctx.proxiedFetcher(subtitlesLink);
      for (const caption of captionsResult) {
        const language = labelToLanguageCode(caption.label);
        const captionType = getCaptionTypeFromUrl(caption.file);
        if (!language || !captionType)
          continue;
        captions.push({
          id: caption.file,
          url: caption.file,
          type: captionType,
          language,
          hasCorsRestrictions: false
        });
      }
    }
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: source,
          flags: [],
          captions,
          preferredHeaders: {
            Referer: referer$2,
            Origin: referer$2
          }
        }
      ]
    };
  }
});
function makeCookieHeader(cookies) {
  return Object.entries(cookies).map(([name, value]) => cookie.serialize(name, value)).join("; ");
}
function parseSetCookie(headerValue) {
  const parsedCookies = setCookieParser.parse(headerValue, {
    map: true
  });
  return parsedCookies;
}
const wootlyScraper = makeEmbed({
  id: "wootly",
  name: "wootly",
  rank: 172,
  async scrape(ctx) {
    var _a, _b;
    const baseUrl3 = "https://www.wootly.ch";
    const wootlyData = await ctx.proxiedFetcher.full(ctx.url, {
      method: "GET",
      readHeaders: ["Set-Cookie"]
    });
    const cookies = parseSetCookie(wootlyData.headers.get("Set-Cookie") || "");
    const wootssesCookie = cookies.wootsses.value;
    let $ = load(wootlyData.body);
    const iframeSrc = $("iframe").attr("src") ?? "";
    const woozCookieRequest = await ctx.proxiedFetcher.full(iframeSrc, {
      method: "GET",
      readHeaders: ["Set-Cookie"],
      headers: {
        cookie: makeCookieHeader({ wootsses: wootssesCookie })
      }
    });
    const woozCookies = parseSetCookie(woozCookieRequest.headers.get("Set-Cookie") || "");
    const woozCookie = woozCookies.wooz.value;
    const iframeData = await ctx.proxiedFetcher(iframeSrc, {
      method: "POST",
      body: new URLSearchParams({ qdf: "1" }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: makeCookieHeader({ wooz: woozCookie }),
        Referer: iframeSrc
      }
    });
    $ = load(iframeData);
    const scriptText = $("script").html() ?? "";
    const tk = (_a = scriptText.match(/tk=([^;]+)/)) == null ? void 0 : _a[0].replace(/tk=|["\s]/g, "");
    const vd = (_b = scriptText.match(/vd=([^,]+)/)) == null ? void 0 : _b[0].replace(/vd=|["\s]/g, "");
    if (!tk || !vd)
      throw new Error("wootly source not found");
    const url = await ctx.proxiedFetcher(`/grabd`, {
      baseUrl: baseUrl3,
      query: { t: tk, id: vd },
      method: "GET",
      headers: {
        cookie: makeCookieHeader({ wooz: woozCookie, wootsses: wootssesCookie })
      }
    });
    if (!url)
      throw new Error("wootly source not found");
    return {
      stream: [
        {
          id: "primary",
          type: "file",
          flags: [flags.IP_LOCKED],
          captions: [],
          qualities: {
            unknown: {
              type: "mp4",
              url: `https://railwayproxy-production.up.railway.app/?destination=${encodeURIComponent(url)}`
            }
          }
        }
      ]
    };
  }
});
const baseUrl = "https://www.goojara.to";
const baseUrl2 = "https://ww1.goojara.to";
async function getEmbeds(ctx, id) {
  const data2 = await ctx.proxiedFetcher.full(`/${id}`, {
    baseUrl: baseUrl2,
    headers: {
      Referer: baseUrl,
      cookie: ""
    },
    readHeaders: ["Set-Cookie"],
    method: "GET"
  });
  const cookies = parseSetCookie(data2.headers.get("Set-Cookie") || "");
  const RandomCookieName = data2.body.split(`_3chk('`)[1].split(`'`)[0];
  const RandomCookieValue = data2.body.split(`_3chk('`)[1].split(`'`)[2];
  let aGoozCookie = "";
  let cookie2 = "";
  if (cookies && cookies.aGooz && RandomCookieName && RandomCookieValue) {
    aGoozCookie = cookies.aGooz.value;
    cookie2 = makeCookieHeader({
      aGooz: aGoozCookie,
      [RandomCookieName]: RandomCookieValue
    });
  }
  const $ = load(data2.body);
  const embedRedirectURLs = $("a").map((index, element) => $(element).attr("href")).get().filter((href) => href && href.includes(`${baseUrl2}/go.php`));
  const embedPages = await Promise.all(
    embedRedirectURLs.map(
      (url) => ctx.proxiedFetcher.full(url, {
        headers: {
          cookie: cookie2,
          Referer: baseUrl2
        },
        method: "GET"
      }).catch(() => null)
      // Handle errors gracefully
    )
  );
  const results = [];
  for (const result of embedPages) {
    if (result) {
      const embedId = ["wootly", "upstream", "mixdrop", "dood"].find((a) => result.finalUrl.includes(a));
      if (embedId) {
        results.push({ embedId, url: result.finalUrl });
      }
    }
  }
  return results;
}
let data;
const headersData = {
  "content-type": "application/x-www-form-urlencoded",
  "cookie": "aGooz=vtnau5fgvdjpr5v8186suabhu5; 52228e86=9107839784b0af77cdb6cf",
  "Referer": "https://www.goojara.to/",
  "Referrer-Policy": "strict-origin-when-cross-origin"
};
async function searchAndFindMedia(ctx, media) {
  data = await ctx.proxiedFetcher(`/xhrr.php`, {
    baseUrl,
    headers: headersData,
    method: "POST",
    body: new URLSearchParams({ q: media.title })
  });
  const $ = load(data);
  const results = [];
  $(".mfeed > li").each((index, element) => {
    var _a;
    const title = $(element).find("strong").text();
    const yearMatch = $(element).text().match(/\((\d{4})\)/);
    const typeDiv = $(element).find("div").attr("class");
    const type = typeDiv === "it" ? "show" : typeDiv === "im" ? "movie" : "";
    const year = yearMatch ? yearMatch[1] : "";
    const slug = (_a = $(element).find("a").attr("href")) == null ? void 0 : _a.split("/")[3];
    if (!slug)
      throw new NotFoundError("Not found");
    if (media.type === type) {
      results.push({ title, year, slug, type });
    }
  });
  const result = results.find((res) => compareMedia(media, res.title, Number(res.year)));
  return result;
}
async function scrapeIds(ctx, media, result) {
  let id = null;
  if (media.type === "movie") {
    id = result.slug;
  } else if (media.type === "show") {
    data = await ctx.proxiedFetcher(`/${result.slug}`, {
      baseUrl,
      headers: headersData,
      method: "GET",
      query: { s: media.season.number.toString() }
    });
    let episodeId = "";
    const $2 = load(data);
    $2(".seho").each((index, element) => {
      const episodeNumber = $2(element).find(".seep .sea").text().trim();
      if (parseInt(episodeNumber, 10) === media.episode.number) {
        const href = $2(element).find(".snfo h1 a").attr("href");
        const idMatch = href == null ? void 0 : href.match(/\/([a-zA-Z0-9]+)$/);
        if (idMatch && idMatch[1]) {
          episodeId = idMatch[1];
          return false;
        }
      }
    });
    id = episodeId;
  }
  if (id === null)
    throw new NotFoundError("Not found");
  const embeds = await getEmbeds(ctx, id);
  return embeds;
}
async function universalScraper$4(ctx) {
  const goojaraData = await searchAndFindMedia(ctx, ctx.media);
  if (!goojaraData)
    throw new NotFoundError("Media not found");
  ctx.progress(30);
  const embeds = await scrapeIds(ctx, ctx.media, goojaraData);
  if ((embeds == null ? void 0 : embeds.length) === 0)
    throw new NotFoundError("No embeds found");
  ctx.progress(60);
  return {
    embeds
  };
}
const goojaraScraper = makeSourcerer({
  id: "goojara",
  name: "Goojara",
  rank: 330,
  flags: [],
  scrapeShow: universalScraper$4,
  scrapeMovie: universalScraper$4
});
const nepuBase = "https://nepu.to";
const nepuReferer = `${nepuBase}/`;
const universalScraper$3 = async (ctx) => {
  const searchResultRequest = await ctx.proxiedFetcher("/ajax/posts", {
    baseUrl: nepuBase,
    query: {
      q: ctx.media.title
    }
  });
  const searchResult = JSON.parse(searchResultRequest);
  const show = searchResult.data.find((item) => {
    if (!item)
      return false;
    if (ctx.media.type === "movie" && item.type !== "Movie")
      return false;
    if (ctx.media.type === "show" && item.type !== "Serie")
      return false;
    return compareTitle(ctx.media.title, item.name);
  });
  if (!show)
    throw new NotFoundError("No watchable item found");
  let videoUrl = show.url;
  if (ctx.media.type === "show") {
    videoUrl = `${show.url}/season/${ctx.media.season.number}/episode/${ctx.media.episode.number}`;
  }
  const videoPage = await ctx.proxiedFetcher(videoUrl, {
    baseUrl: nepuBase
  });
  const videoPage$ = load(videoPage);
  const embedId = videoPage$("a[data-embed]").attr("data-embed");
  if (!embedId)
    throw new NotFoundError("No embed found.");
  const playerPage = await ctx.proxiedFetcher("/ajax/embed", {
    method: "POST",
    baseUrl: nepuBase,
    body: new URLSearchParams({ id: embedId })
  });
  const streamUrl = playerPage.match(/"file":"(http[^"]+)"/);
  if (!streamUrl)
    throw new NotFoundError("No stream found.");
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        captions: [],
        playlist: streamUrl[1],
        type: "hls",
        flags: [],
        headers: {
          Origin: nepuBase,
          Referer: nepuReferer
        }
      }
    ]
  };
};
const nepuScraper = makeSourcerer({
  id: "nepu",
  name: "Nepu",
  rank: 111,
  disabled: true,
  flags: [],
  scrapeMovie: universalScraper$3,
  scrapeShow: universalScraper$3
});
const ridoMoviesBase = `https://ridomovies.tv`;
const ridoMoviesApiBase = `${ridoMoviesBase}/core/api`;
const universalScraper$2 = async (ctx) => {
  const searchResult = await ctx.proxiedFetcher("/search", {
    baseUrl: ridoMoviesApiBase,
    query: {
      q: ctx.media.title
    }
  });
  const show = searchResult.data.items[0];
  if (!show)
    throw new NotFoundError("No watchable item found");
  let iframeSourceUrl = `/${show.fullSlug}/videos`;
  if (ctx.media.type === "show") {
    const showPageResult = await ctx.proxiedFetcher(`/${show.fullSlug}`, {
      baseUrl: ridoMoviesBase
    });
    const fullEpisodeSlug = `season-${ctx.media.season.number}/episode-${ctx.media.episode.number}`;
    const regexPattern = new RegExp(
      `\\\\"id\\\\":\\\\"(\\d+)\\\\"(?=.*?\\\\\\"fullSlug\\\\\\":\\\\\\"[^"]*${fullEpisodeSlug}[^"]*\\\\\\")`,
      "g"
    );
    const matches = [...showPageResult.matchAll(regexPattern)];
    const episodeIds = matches.map((match) => match[1]);
    if (episodeIds.length === 0)
      throw new NotFoundError("No watchable item found");
    const episodeId = episodeIds.at(-1);
    iframeSourceUrl = `/episodes/${episodeId}/videos`;
  }
  const iframeSource = await ctx.proxiedFetcher(iframeSourceUrl, {
    baseUrl: ridoMoviesApiBase
  });
  const iframeSource$ = load(iframeSource.data[0].url);
  const iframeUrl = iframeSource$("iframe").attr("data-src");
  if (!iframeUrl)
    throw new NotFoundError("No watchable item found");
  const embeds = [];
  if (iframeUrl.includes("closeload")) {
    embeds.push({
      embedId: closeLoadScraper.id,
      url: iframeUrl
    });
  }
  if (iframeUrl.includes("ridoo")) {
    embeds.push({
      embedId: ridooScraper.id,
      url: iframeUrl
    });
  }
  return {
    embeds
  };
};
const ridooMoviesScraper = makeSourcerer({
  id: "ridomovies",
  name: "RidoMovies",
  rank: 30,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: universalScraper$2,
  scrapeShow: universalScraper$2
});
const smashyStreamBase = "https://embed.smashystream.com";
const referer$1 = "https://smashystream.com/";
const universalScraper$1 = async (ctx) => {
  const mainPage = await ctx.proxiedFetcher("/playere.php", {
    query: {
      tmdb: ctx.media.tmdbId,
      ...ctx.media.type === "show" && {
        season: ctx.media.season.number.toString(),
        episode: ctx.media.episode.number.toString()
      }
    },
    headers: {
      Referer: referer$1
    },
    baseUrl: smashyStreamBase
  });
  ctx.progress(30);
  const mainPage$ = load(mainPage);
  const sourceUrls = mainPage$(".dropdown-menu a[data-url]").map((_, el) => mainPage$(el).attr("data-url")).get();
  const embeds = [];
  for (const sourceUrl of sourceUrls) {
    if (sourceUrl.includes("video1d.php")) {
      embeds.push({
        embedId: smashyStreamFScraper.id,
        url: sourceUrl
      });
    }
    if (sourceUrl.includes("dued.php")) {
      embeds.push({
        embedId: smashyStreamDScraper.id,
        url: sourceUrl
      });
    }
  }
  ctx.progress(60);
  return {
    embeds
  };
};
const smashyStreamScraper = makeSourcerer({
  id: "smashystream",
  name: "SmashyStream",
  rank: 70,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: universalScraper$1,
  scrapeShow: universalScraper$1
});
const vidSrcToBase = "https://vidsrc.to";
const referer = `${vidSrcToBase}/`;
const universalScraper = async (ctx) => {
  const imdbId = ctx.media.imdbId;
  const tmdbId = ctx.media.tmdbId;
  const url = ctx.media.type === "movie" ? `/embed/movie/${imdbId || tmdbId}` : `/embed/tv/${imdbId || tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  const mainPage = await ctx.proxiedFetcher(url, {
    baseUrl: vidSrcToBase,
    headers: {
      referer
    }
  });
  const mainPage$ = load(mainPage);
  const dataId = mainPage$("a[data-id]").attr("data-id");
  if (!dataId)
    throw new Error("No data-id found");
  const sources = await ctx.proxiedFetcher(`/ajax/embed/episode/${dataId}/sources`, {
    baseUrl: vidSrcToBase,
    headers: {
      referer
    }
  });
  if (sources.status !== 200)
    throw new Error("No sources found");
  const embeds = [];
  const embedUrls = [];
  for (const source of sources.result) {
    const sourceRes = await ctx.proxiedFetcher(`/ajax/embed/source/${source.id}`, {
      baseUrl: vidSrcToBase,
      headers: {
        referer
      }
    });
    const decryptedUrl = decryptSourceUrl(sourceRes.result.url);
    embedUrls.push(decryptedUrl);
  }
  const urlWithSubtitles = embedUrls.find((v) => v.includes("sub.info"));
  let subtitleUrl = null;
  if (urlWithSubtitles)
    subtitleUrl = new URL(urlWithSubtitles).searchParams.get("sub.info");
  for (const source of sources.result) {
    if (source.title === "Vidplay") {
      const embedUrl = embedUrls.find((v) => v.includes("vidplay"));
      if (!embedUrl)
        continue;
      embeds.push({
        embedId: "vidplay",
        url: embedUrl
      });
    }
    if (source.title === "Filemoon") {
      const embedUrl = embedUrls.find((v) => v.includes("filemoon"));
      if (!embedUrl)
        continue;
      const fullUrl = new URL(embedUrl);
      if (subtitleUrl)
        fullUrl.searchParams.set("sub.info", subtitleUrl);
      embeds.push({
        embedId: "filemoon",
        url: fullUrl.toString()
      });
    }
  }
  return {
    embeds
  };
};
const vidSrcToScraper = makeSourcerer({
  id: "vidsrcto",
  name: "VidSrcTo",
  scrapeMovie: universalScraper,
  scrapeShow: universalScraper,
  flags: [],
  rank: 250
});
function gatherAllSources() {
  return [
    flixhqScraper,//
    remotestreamScraper,//
    kissAsianScraper,
    showboxScraper,
    goMoviesScraper,//
    zoechipScraper,//
    vidsrcScraper,
    lookmovieScraper,
    smashyStreamScraper,//
    ridooMoviesScraper,//
    vidSrcToScraper,
    nepuScraper,//
    goojaraScraper
  ];
}
function gatherAllEmbeds() {
  return [
    upcloudScraper,
    vidCloudScraper,
    mp4uploadScraper,
    streamsbScraper,
    upstreamScraper,
    febboxMp4Scraper,
    febboxHlsScraper,
    mixdropScraper,
    vidsrcembedScraper,
    streambucketScraper,
    smashyStreamFScraper,
    smashyStreamDScraper,
    ridooScraper,
    closeLoadScraper,
    fileMoonScraper,
    vidplayScraper,
    wootlyScraper,
    doodScraper
  ];
}
function getBuiltinSources() {
  return gatherAllSources().filter((v) => !v.disabled);
}
function getBuiltinEmbeds() {
  return gatherAllEmbeds().filter((v) => !v.disabled);
}
function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}
function getProviders(features, list) {
  const sources = list.sources.filter((v) => !(v == null ? void 0 : v.disabled));
  const embeds = list.embeds.filter((v) => !(v == null ? void 0 : v.disabled));
  const combined = [...sources, ...embeds];
  const anyDuplicateId = hasDuplicates(combined.map((v) => v.id));
  const anyDuplicateSourceRank = hasDuplicates(sources.map((v) => v.rank));
  const anyDuplicateEmbedRank = hasDuplicates(embeds.map((v) => v.rank));
  if (anyDuplicateId)
    throw new Error("Duplicate id found in sources/embeds");
  if (anyDuplicateSourceRank)
    throw new Error("Duplicate rank found in sources");
  if (anyDuplicateEmbedRank)
    throw new Error("Duplicate rank found in embeds");
  return {
    sources: sources.filter((s) => flagsAllowedInFeatures(features, s.flags)),
    embeds
  };
}
function makeProviders(ops) {
  const features = getTargetFeatures(ops.target, ops.consistentIpForRequests ?? false);
  const list = getProviders(features, {
    embeds: getBuiltinEmbeds(),
    sources: getBuiltinSources()
  });
  return makeControls({
    embeds: list.embeds,
    sources: list.sources,
    features,
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher
  });
}
function buildProviders() {
  let consistentIpForRequests = false;
  let target = null;
  let fetcher = null;
  let proxiedFetcher = null;
  const embeds = [];
  const sources = [];
  const builtinSources = getBuiltinSources();
  const builtinEmbeds = getBuiltinEmbeds();
  return {
    enableConsistentIpForRequests() {
      consistentIpForRequests = true;
      return this;
    },
    setFetcher(f) {
      fetcher = f;
      return this;
    },
    setProxiedFetcher(f) {
      proxiedFetcher = f;
      return this;
    },
    setTarget(t) {
      target = t;
      return this;
    },
    addSource(input) {
      if (typeof input !== "string") {
        sources.push(input);
        return this;
      }
      const matchingSource = builtinSources.find((v) => v.id === input);
      if (!matchingSource)
        throw new Error("Source not found");
      sources.push(matchingSource);
      return this;
    },
    addEmbed(input) {
      if (typeof input !== "string") {
        embeds.push(input);
        return this;
      }
      const matchingEmbed = builtinEmbeds.find((v) => v.id === input);
      if (!matchingEmbed)
        throw new Error("Embed not found");
      embeds.push(matchingEmbed);
      return this;
    },
    addBuiltinProviders() {
      sources.push(...builtinSources);
      embeds.push(...builtinEmbeds);
      return this;
    },
    build() {
      if (!target)
        throw new Error("Target not set");
      if (!fetcher)
        throw new Error("Fetcher not set");
      const features = getTargetFeatures(target, consistentIpForRequests);
      const list = getProviders(features, {
        embeds,
        sources
      });
      return makeControls({
        fetcher,
        proxiedFetcher: proxiedFetcher ?? void 0,
        embeds: list.embeds,
        sources: list.sources,
        features
      });
    }
  };
}
const isReactNative = () => {
  try {
    require("react-native");
    return true;
  } catch (e) {
    return false;
  }
};
function serializeBody(body) {
  if (body === void 0 || typeof body === "string" || body instanceof URLSearchParams || body instanceof FormData) {
    if (body instanceof URLSearchParams && isReactNative()) {
      return {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      };
    }
    return {
      headers: {},
      body
    };
  }
  return {
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}
function getHeaders(list, res) {
  const output = new Headers();
  list.forEach((header) => {
    var _a;
    const realHeader = header.toLowerCase();
    const value = res.headers.get(realHeader);
    const extraValue = (_a = res.extraHeaders) == null ? void 0 : _a.get(realHeader);
    if (!value)
      return;
    output.set(realHeader, extraValue ?? value);
  });
  return output;
}
function makeStandardFetcher(f) {
  const normalFetch = async (url, ops) => {
    var _a;
    const fullUrl = makeFullUrl(url, ops);
    const seralizedBody = serializeBody(ops.body);
    const res = await f(fullUrl, {
      method: ops.method,
      headers: {
        ...seralizedBody.headers,
        ...ops.headers
      },
      body: seralizedBody.body
    });
    let body;
    const isJson = (_a = res.headers.get("content-type")) == null ? void 0 : _a.includes("application/json");
    if (isJson)
      body = await res.json();
    else
      body = await res.text();
    return {
      body,
      finalUrl: res.extraUrl ?? res.url,
      headers: getHeaders(ops.readHeaders, res),
      statusCode: res.status
    };
  };
  return normalFetch;
}
const headerMap = {
  cookie: "X-Cookie",
  referer: "X-Referer",
  origin: "X-Origin",
  "user-agent": "X-User-Agent",
  "x-real-ip": "X-X-Real-Ip"
};
const responseHeaderMap = {
  "x-set-cookie": "Set-Cookie"
};
function makeSimpleProxyFetcher(proxyUrl, f) {
  const proxiedFetch = async (url, ops) => {
    const fetcher = makeStandardFetcher(async (a, b) => {
      const res = await f(a, b);
      res.extraHeaders = new Headers();
      Object.entries(responseHeaderMap).forEach((entry) => {
        var _a;
        const value = res.headers.get(entry[0]);
        if (!value)
          return;
        (_a = res.extraHeaders) == null ? void 0 : _a.set(entry[0].toLowerCase(), value);
      });
      res.extraUrl = res.headers.get("X-Final-Destination") ?? res.url;
      return res;
    });
    const fullUrl = makeFullUrl(url, ops);
    const headerEntries = Object.entries(ops.headers).map((entry) => {
      const key2 = entry[0].toLowerCase();
      if (headerMap[key2])
        return [headerMap[key2], entry[1]];
      return entry;
    });
    return fetcher(proxyUrl, {
      ...ops,
      query: {
        destination: fullUrl
      },
      headers: Object.fromEntries(headerEntries),
      baseUrl: void 0
    });
  };
  return proxiedFetch;
}
export {
  NotFoundError,
  buildProviders,
  flags,
  getBuiltinEmbeds,
  getBuiltinSources,
  makeProviders,
  makeSimpleProxyFetcher,
  makeStandardFetcher,
  targets
};
