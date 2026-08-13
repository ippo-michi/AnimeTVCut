export interface StremioCatalogExtra {
  name: string;
  isRequired: boolean;
}

export interface StremioCatalogDeclaration {
  id: string;
  type: string;
  name?: string;
  extra: readonly StremioCatalogExtra[];
}

export interface MetadataStremioManifest {
  id: string;
  name: string;
  version: string;
  types: readonly string[];
  resources: readonly string[];
  catalogs: readonly StremioCatalogDeclaration[];
}

export interface StremioMetaPreview {
  id: string;
  type: "series";
  name: string;
  poster?: string;
  posterShape?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
  genres?: readonly string[];
}

export interface SourceEpisodeMeta {
  id: string;
  season: number;
  episode: number;
  runtimeSeconds?: number;
  title?: string;
  released?: string;
  thumbnail?: string;
}

export interface SourceSeriesMeta extends StremioMetaPreview {
  runtimeSeconds?: number;
  malAnimeId?: number;
  kitsuAnimeId?: number;
  videos: readonly SourceEpisodeMeta[];
}
