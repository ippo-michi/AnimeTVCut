import type { FastifyPluginAsync } from "fastify";
import {
  encodePreferences,
  playbackPreferencesSchema,
} from "../services/playback-preferences.js";

export function configurationRoutes(options: {
  publicBaseUrl?: URL;
  defaults: { episodesPerGroup: number; maximumEpisodes: number };
  connections: () => Promise<unknown>;
}): FastifyPluginAsync {
  return async (app) => {
    for (const url of [
      "/",
      "/configure",
      "/v2/configure",
      "/p/:profile/configure",
      "/p/:profile/v2/configure",
    ])
      app.get(url, async (_request, reply) =>
        reply
          .header(
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          )
          .header("referrer-policy", "no-referrer")
          .type("text/html; charset=utf-8")
          .send(configurationHtml),
      );
    app.get("/configure.js", async (_request, reply) =>
      reply.type("text/javascript").send(configurationScript),
    );
    app.get("/api/v1/configuration", async () => ({
      defaults: options.defaults,
      manifestUrl:
        options.publicBaseUrl === undefined
          ? undefined
          : new URL("v2/manifest.json", options.publicBaseUrl).href,
    }));
    app.post("/api/v1/configuration/profile", async (request, reply) => {
      const parsed = playbackPreferencesSchema.safeParse(request.body);
      if (
        !parsed.success ||
        (parsed.data.episodesPerGroup ?? 1) > options.defaults.maximumEpisodes
      )
        return reply.code(400).send({
          error: "Invalid preferences or group size exceeds the server limit.",
        });
      if (options.publicBaseUrl === undefined)
        return reply
          .code(503)
          .send({ error: "The server's public URL has not been configured." });
      const profile = encodePreferences(parsed.data);
      return {
        profile,
        manifestUrl: new URL(
          `p/${profile}/v2/manifest.json`,
          options.publicBaseUrl,
        ).href,
      };
    });
    // Coalesce checks and briefly cache results so this public button cannot fan out probes.
    let pending: Promise<unknown> | undefined;
    let expires = 0;
    app.get("/api/v1/configuration/connections", async () => {
      if (pending === undefined || Date.now() >= expires) {
        expires = Date.now() + 30_000;
        pending = options.connections().catch(() => ({ ready: false }));
      }
      return pending;
    });
  };
}

const configurationHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AnimeTVCut · Configure</title>
<style>:root{color-scheme:dark;font:16px system-ui;background:#0d1220;color:#e7edf8}body{max-width:900px;margin:48px auto;padding:0 22px}h1{font-size:2.4rem;margin-bottom:8px}p{line-height:1.6;color:#b9c7dc}section{background:#151e30;border:1px solid #293752;border-radius:16px;padding:24px;margin:24px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px}label{display:block;line-height:1.7}select,input,button,a.button{font:inherit;border:1px solid #405478;border-radius:8px;padding:10px;background:#10192b;color:inherit}select,input{box-sizing:border-box;width:100%}button,a.button{cursor:pointer;background:#314ea3;display:inline-block;text-decoration:none;margin:12px 8px 0 0}button:disabled{opacity:.5;cursor:wait}output{display:block;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:14px}a{color:#a9c4ff}.muted{font-size:.9rem}[hidden]{display:none!important}#results button{display:block;background:#192842;text-align:left;width:100%}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px;border-bottom:1px solid #293752}</style>
<h1>AnimeTVCut</h1><p>Turn episodes into a continuous TV, season, or complete series cut.</p>
<section><h2>Install and preferences</h2><p>Your server settings provide the defaults. These choices create a personal install link.</p>
<form id="preferences"><div class="grid">
<label>Episodes per TV Cut<select name="episodesPerGroup" id="group"></select></label>
<label>Openings<select name="openings"><option value="remove_all">Remove verified openings</option><option value="first_only">Keep the first opening</option><option value="keep_all">Keep all openings</option></select></label>
<label>Endings<select name="endings"><option value="remove_all">Remove verified endings</option><option value="last_only">Keep the final ending</option><option value="keep_all">Keep all endings</option></select></label>
<label>Recaps<select name="removeRecaps"><option value="true">Remove verified recaps</option><option value="false">Keep recaps</option></select></label>
<label>Previews<select name="removePreviews"><option value="true">Remove verified previews</option><option value="false">Keep previews</option></select></label>
<label>Audio preference<select name="language"><option value="default">Server default</option><option value="japanese">Japanese</option><option value="english">English dub</option><option value="dual">Dual audio</option></select></label>
<label>Maximum source resolution<select name="maxResolution"><option value="unlimited">Server default / no limit</option><option value="720">720p</option><option value="1080">1080p</option><option value="2160">2160p</option></select></label>
<label>Playback priority<select name="priority"><option value="startup">Faster startup</option><option value="quality">Higher source quality</option></select></label>
</div><button type="submit">Create install link</button><a class="button" id="install" hidden>Install in Stremio</a><a id="manifest" hidden>Manifest</a><output id="install-status" aria-live="polite"></output></form>
<button id="connections" type="button">Check server connections</button><output id="connection-status" aria-live="polite"></output></section>
<section><h2>Preview a cut</h2><p>Search for a series to see available cuts and why others are pending. Preparing a preview also checks verified edits against the selected release.</p><form id="search"><label>Series title<input name="query" required maxlength="200" placeholder="Search your metadata addon"></label><button>Search</button></form><output id="search-status" aria-live="polite"></output><div id="results"></div><div id="preview"></div></section>
<p class="muted">Only verified boundaries are removed. Audio preferences rank source releases; choose the audio track in your player. Playback preferences never change the server's upstream credentials.</p><script src="/configure.js" defer></script></html>`;

const configurationScript = `"use strict";
let profile = location.pathname.match(/^\\/p\\/([^/]+)/)?.[1];
const el = id => document.getElementById(id);
const message = (id, text) => { el(id).textContent = text; };
async function api(url, options) { const r = await fetch(url, options); const data = await r.json(); if (!r.ok) throw Error(data.error || data.message || "Request failed. Try again shortly."); return data; }
const prefix = () => profile ? "/p/" + encodeURIComponent(profile) : "";
function install(url) { const a = el("install"); a.href = url.replace(/^https?:/, "stremio:"); a.hidden = false; el("manifest").href = url; el("manifest").hidden = false; message("install-status", url); }
api("/api/v1/configuration").then(data => {
 const group = el("group"); const fallback=document.createElement("option");fallback.value="";fallback.textContent="Server default ("+data.defaults.episodesPerGroup+")";group.append(fallback);for(let i=1;i<=Math.min(12,data.defaults.maximumEpisodes);i++){ const o=document.createElement("option");o.value=i;o.textContent=i;group.append(o); }group.value="";
 if(profile){ try { const p=JSON.parse(atob(profile.replace(/-/g,"+").replace(/_/g,"/")));for(const [k,v] of Object.entries(p)){const field=el("preferences").elements.namedItem(k);if(field)field.value=String(v);} }catch{message("install-status","Invalid profile. Create a new install link.");} }
 const cut=new URLSearchParams(location.hash.slice(1)).get("cut");if(cut)prepare(cut);
 if(data.manifestUrl)install(profile ? new URL("/p/"+profile+"/v2/manifest.json",data.manifestUrl).href : data.manifestUrl);
}).catch(e=>message("install-status",e.message));
el("preferences").addEventListener("submit",async event=>{event.preventDefault();try{const p=Object.fromEntries(new FormData(event.currentTarget));if(p.episodesPerGroup==="")delete p.episodesPerGroup;else p.episodesPerGroup=Number(p.episodesPerGroup);p.removeRecaps=p.removeRecaps==="true";p.removePreviews=p.removePreviews==="true";const data=await api("/api/v1/configuration/profile",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(p)});profile=data.profile;install(data.manifestUrl);history.replaceState(null,"","/p/"+profile+"/configure");el("results").replaceChildren();el("preview").replaceChildren();}catch(e){message("install-status",e.message);}});
el("connections").addEventListener("click",async event=>{event.currentTarget.disabled=true;try{const data=await api("/api/v1/configuration/connections");message("connection-status",Object.entries(data.dependencies||{}).map(([name,state])=>name+": "+(state.ready?"Ready":state.configured?"Unavailable":"Not configured")).join("\\n"));}catch(e){message("connection-status",e.message);}finally{el("connections").disabled=false;}});
// Preview interactions are populated by the public metadata and preparation APIs.
el("search").addEventListener("submit",async event=>{event.preventDefault();message("search-status","Searching…");el("results").replaceChildren();el("preview").replaceChildren();try{const q=new FormData(event.currentTarget).get("query");const data=await api(prefix()+"/v2/catalog/series/animetvcut-v2/search="+encodeURIComponent(q)+".json");message("search-status",data.metas.length?"Choose a cut mode:":"No results. Check the title or server connections.");for(const meta of data.metas){const b=document.createElement("button");b.textContent=meta.name;b.onclick=()=>showPlan(meta.id);el("results").append(b);}}catch(e){message("search-status",e.message);}});
async function showPlan(id){message("search-status","Loading available cuts…");try{const data=await api(prefix()+"/api/v1/preview/plan/"+encodeURIComponent(id));const box=el("preview");box.replaceChildren();for(const cut of data.cuts){const b=document.createElement("button");b.textContent=cut.title+" · "+Math.round(cut.estimatedDurationSeconds/60)+" min";b.disabled=!cut.available;if(!cut.available)b.textContent+=" · "+cut.message;else b.onclick=()=>prepare(cut.id);box.append(b);}message("search-status",data.cuts.length?"Select a cut to inspect its episodes and edits.":"No episodes are available yet.");}catch(e){message("search-status",e.message);}}
async function prepare(id){message("search-status","Preparing preview: checking sources and verified edits…");try{const data=await api(prefix()+"/api/v1/preview/cut/"+encodeURIComponent(id));const box=el("preview");box.replaceChildren();const title=document.createElement("h3");title.textContent=data.title+" · "+Math.round(data.duration/60)+" min";box.append(title);for(const episode of data.episodes){const p=document.createElement("p");p.textContent="Season "+episode.season+", episode "+episode.episode+(episode.title?": "+episode.title:"");box.append(p);}const labels=new Map(data.episodes.map(e=>[e.id,"S"+e.season+" E"+e.episode]));const list=document.createElement("output");list.textContent=data.removals.map(r=>labels.get(r.episodeId)+" · "+r.type+": "+r.start.toFixed(1)+"–"+r.end.toFixed(1)+"s").join("\\n")||"No verified removals applied.";box.append(list);const warnings=document.createElement("p");warnings.textContent=data.warnings.join("\\n");box.append(warnings);const link=document.createElement("a");link.textContent="Open prepared playlist";link.href=data.playlistUrl;box.append(link);message("search-status","Preview ready. Removal timestamps refer to the original episode.");}catch(e){message("search-status",e.message);}}
`;
