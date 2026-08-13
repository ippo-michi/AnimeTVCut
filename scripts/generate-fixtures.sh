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
generate_direct_episode 7 0x5f3dc4 1320
generate_direct_episode 8 0x1098ad 1430
generate_direct_episode 9 0xe67700 1540
generate_direct_episode 10 0xa61e4d 1650
generate_direct_episode 11 0x1864ab 1760
generate_direct_episode 12 0x862e9c 1870

generate_mediaflow_control() {
  local output_name="$1"
  local video_codec="$2"
  local audio_codec="$3"
  local pixel_format="$4"
  local output_file="${media_fixture_root}/${output_name}"

  if [[ -f "${output_file}" ]] && [[ "${FORCE_FIXTURES:-0}" != "1" ]]; then
    return
  fi

  mkdir -p "${media_fixture_root}"
  local -a video_options=(
    -c:v "${video_codec}"
    -pix_fmt "${pixel_format}"
    -g 150
    -keyint_min 150
    -force_key_frames "expr:gte(t,n_forced*6)"
  )
  if [[ "${video_codec}" == "libx264" ]]; then
    video_options+=( -preset ultrafast -sc_threshold 0 )
  else
    video_options+=(
      -preset ultrafast
      -x265-params "pools=1:frame-threads=1:keyint=150:min-keyint=150:scenecut=0"
    )
  fi

  local -a container_options=()
  if [[ "${output_name}" == *.mp4 ]]; then
    container_options+=( -movflags +faststart )
  fi

  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=s=320x180:r=25:d=18" \
    -f lavfi -i "sine=frequency=523:sample_rate=48000:duration=18" \
    -map 0:v:0 -map 1:a:0 \
    "${video_options[@]}" \
    -c:a "${audio_codec}" -b:a 64k -ar 48000 \
    "${container_options[@]}" \
    "${output_file}"
}

generate_mediaflow_control control-h264-aac.mp4 libx264 aac yuv420p
generate_mediaflow_control control-h264-aac.mkv libx264 aac yuv420p
generate_mediaflow_control control-h264-eac3.mkv libx264 eac3 yuv420p
generate_mediaflow_control control-hevc-opus.mkv libx265 libopus yuv420p10le
