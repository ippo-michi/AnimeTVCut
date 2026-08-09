#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="${project_root}/fixtures/hls"
media_fixture_root="${project_root}/fixtures/media"

generate_episode() {
  local number="$1"
  local story_color="$2"
  local story_tone="$3"
  local format="$4"
  local directory_prefix=""
  local expected_resource="seg00.ts"
  if [[ "${format}" == "fmp4" ]]; then
    directory_prefix="fmp4-"
    expected_resource="init.mp4"
  fi
  local output_dir="${fixture_root}/${directory_prefix}episode${number}"

  if [[ -f "${output_dir}/playlist.m3u8" ]] \
    && [[ -f "${output_dir}/${expected_resource}" ]] \
    && [[ "${FORCE_FIXTURES:-0}" != "1" ]]; then
    return
  fi

  mkdir -p "${output_dir}"
  local -a segment_options
  if [[ "${format}" == "fmp4" ]]; then
    segment_options=(
      -hls_segment_type fmp4
      -hls_fmp4_init_filename init.mp4
      -hls_segment_filename "${output_dir}/seg%02d.m4s"
    )
  else
    segment_options=(
      -hls_segment_filename "${output_dir}/seg%02d.ts"
    )
  fi

  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=0x2f9e44:s=320x180:r=25:d=6" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" \
    -f lavfi -i "color=c=${story_color}:s=320x180:r=25:d=18" \
    -f lavfi -i "sine=frequency=${story_tone}:sample_rate=48000:duration=18" \
    -f lavfi -i "color=c=0x9c36b5:s=320x180:r=25:d=6" \
    -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=6" \
    -filter_complex \
      "[0:v][1:a][2:v][3:a][4:v][5:a]concat=n=3:v=1:a=1[v][a]" \
    -map "[v]" -map "[a]" \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
    -g 150 -keyint_min 150 -sc_threshold 0 \
    -force_key_frames "expr:gte(t,n_forced*6)" \
    -c:a aac -b:a 64k -ar 48000 \
    -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments \
    "${segment_options[@]}" \
    "${output_dir}/playlist.m3u8"
}

generate_episode 1 0xc92a2a 550 mpegts
generate_episode 2 0x1971c2 660 mpegts
generate_episode 3 0xf08c00 770 mpegts
generate_episode 1 0xc92a2a 550 fmp4
generate_episode 2 0x1971c2 660 fmp4
generate_episode 3 0xf08c00 770 fmp4

generate_direct_episode() {
  local number="$1"
  local story_color="$2"
  local story_tone="$3"
  local output_file="${media_fixture_root}/episode${number}.mkv"

  if [[ -f "${output_file}" ]] && [[ "${FORCE_FIXTURES:-0}" != "1" ]]; then
    return
  fi

  mkdir -p "${media_fixture_root}"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=0x2f9e44:s=320x180:r=25:d=6" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" \
    -f lavfi -i "color=c=${story_color}:s=320x180:r=25:d=18" \
    -f lavfi -i "sine=frequency=${story_tone}:sample_rate=48000:duration=18" \
    -f lavfi -i "color=c=0x9c36b5:s=320x180:r=25:d=6" \
    -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=6" \
    -filter_complex \
      "[0:v][1:a][2:v][3:a][4:v][5:a]concat=n=3:v=1:a=1[v][a]" \
    -map "[v]" -map "[a]" \
    -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 400k \
    -g 150 -keyint_min 150 \
    -force_key_frames "expr:gte(t,n_forced*6)" \
    -c:a libopus -b:a 64k -ar 48000 \
    "${output_file}"
}

generate_direct_episode 1 0xc92a2a 550
generate_direct_episode 2 0x1971c2 660
generate_direct_episode 3 0xf08c00 770
generate_direct_episode 4 0x7048e8 990
generate_direct_episode 5 0x0b7285 1100
generate_direct_episode 6 0xe64980 1210
