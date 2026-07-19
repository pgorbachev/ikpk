// RU-доступные зеркала видео-плейлистов (FR-04).
// Основная площадка — VK Видео (канал @clubikpk, ~13к подписчиков);
// на странице встраивается RUTUBE-плеер (RU-доступен, официальный эмбед
// одного видео — плейлист-iframe RUTUBE запрещает через X-Frame-Options),
// YouTube в РФ замедлен и как основной эмбед не используется.
//
// Маппинг slug → RUTUBE-плейлист + представительное видео получен из
// публичного RUTUBE API (rutube.ru/api/playlist/custom/<id>/) на 2026-07-19;
// каждому плейлисту подобрано уникальное видео из его состава.

export interface VideoMirror {
  rutubePlaylistId: string;
  rutubePlaylistUrl: string;
  rutubeEmbedVideoId: string;
}

export const VK_CHANNEL_URL = 'https://vkvideo.ru/@clubikpk';
export const RUTUBE_CHANNEL_URL = 'https://rutube.ru/channel/30422569/';

const MIRRORS: Record<string, VideoMirror> = {
  '31': { rutubePlaylistId: '265664', rutubePlaylistUrl: 'https://rutube.ru/plst/265664/', rutubeEmbedVideoId: '8c68aff003aa73ec0b3c669bef1ce2c6' },
  '32': { rutubePlaylistId: '679719', rutubePlaylistUrl: 'https://rutube.ru/plst/679719/', rutubeEmbedVideoId: '97c71358822e4e4145b8a0712d805095' },
  '33': { rutubePlaylistId: '679713', rutubePlaylistUrl: 'https://rutube.ru/plst/679713/', rutubeEmbedVideoId: 'b8c1ddaceb0de14c5838a189c1e17f4c' },
  '34': { rutubePlaylistId: '679712', rutubePlaylistUrl: 'https://rutube.ru/plst/679712/', rutubeEmbedVideoId: '3b6a9b050aefb785e64ac30c84a97ee3' },
  '36': { rutubePlaylistId: '679716', rutubePlaylistUrl: 'https://rutube.ru/plst/679716/', rutubeEmbedVideoId: '9595b319b190cbac5c8c1a7ce3c182d2' },
  '37': { rutubePlaylistId: '679708', rutubePlaylistUrl: 'https://rutube.ru/plst/679708/', rutubeEmbedVideoId: 'd4492cb4adf992499b447527d95dc28f' },
};

export function getVideoMirror(slug: string): VideoMirror | undefined {
  return MIRRORS[slug];
}

export function rutubeEmbedUrl(videoId: string): string {
  return `https://rutube.ru/play/embed/${videoId}`;
}
