import type { OCFile } from '../oc/types';
import type { ArtistFile, ArtistOrigin } from '../artist/types';
import type { TagFile } from './types';

export function fromOC(oc: OCFile, isLocal: boolean): TagFile {
  return {
    id: oc.id,
    subtypeId: 'character',
    name: oc.name,
    preview: oc.preview,
    positive: oc.positive,
    negative: oc.negative || undefined,
    aliases: oc.aliases,
    createdAt: oc.created_at ? oc.created_at * 1000 : undefined,
    createdBy: oc.created_by || oc.user,
    _isLocal: isLocal,
  };
}

export function toOC(tag: TagFile): OCFile {
  return {
    id: tag.id,
    name: tag.name,
    preview: tag.preview || '',
    positive: tag.positive,
    negative: tag.negative || '',
    aliases: tag.aliases,
    user: tag.createdBy,
    created_by: tag.createdBy,
    created_at: tag.createdAt ? Math.floor(tag.createdAt / 1000) : undefined,
  };
}

export function fromArtist(artist: ArtistFile, isLocal: boolean): TagFile {
  const previews = artist.previews || [];
  return {
    id: artist.id,
    subtypeId: 'artist-style',
    name: artist.name,
    preview: previews[0],
    legacyPreviews: previews.length > 1 ? previews : undefined,
    positive: artist.prompt,
    negative: artist.negative,
    tags: artist.tags,
    origin: artist.origin,
    publicId: artist.publicId,
    usageCount: artist.usageCount,
    createdAt: artist.createdTime,
    createdBy: artist.addedBy || undefined,
    _isLocal: isLocal,
  };
}

export function toArtist(tag: TagFile): ArtistFile {
  return {
    id: tag.id,
    name: tag.name,
    previews: tag.legacyPreviews || (tag.preview ? [tag.preview] : []),
    prompt: tag.positive,
    negative: tag.negative,
    usageCount: tag.usageCount,
    createdTime: tag.createdAt,
    addedBy: tag.createdBy || null,
    isLocal: tag._isLocal,
    origin: (tag.origin === 'public' ? undefined : tag.origin) as ArtistOrigin | undefined,
    publicId: tag.publicId,
    tags: tag.tags,
  };
}
