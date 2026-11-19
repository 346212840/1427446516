/* Pure plans for the on-device converter. No network and no ffmpeg here. */
(function (root) {
  "use strict";

  var FORMATS = {
    wav: { ext: "wav", mime: "audio/wav", lossy: false },
    flac: { ext: "flac", mime: "audio/flac", lossy: false },
    alac: { ext: "m4a", mime: "audio/mp4", lossy: false },
    aiff: { ext: "aiff", mime: "audio/aiff", lossy: false },
    mp3: { ext: "mp3", mime: "audio/mpeg", lossy: true },
    aac: { ext: "m4a", mime: "audio/mp4", lossy: true },
    opus: { ext: "opus", mime: "audio/opus", lossy: true },
    vorbis: { ext: "ogg", mime: "audio/ogg", lossy: true },
    voice: { ext: "ogg", mime: "audio/ogg", lossy: true }
  };

  function parseProbe(log) {
    var text = String(log || "");
    var info = { rate: 0, channels: 0, bits: 0, float: false, duration: 0, hasCover: false, audio: false, codec: "" };
    var dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
    if (dur) info.duration = (Number(dur[1]) * 3600) + (Number(dur[2]) * 60) + Number(dur[3]);
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (/Video:/.test(line) && /attached pic|mjpeg|png/.test(line)) info.hasCover = true;
      if (!/Audio:/.test(line)) continue;
      info.audio = true;
      var codec = /Audio:\s*([a-z0-9_]+)/i.exec(line);
      info.codec = codec ? codec[1].toLowerCase() : "";
      var rate = /(\d+)\s*Hz/.exec(line);
      if (rate) info.rate = Number(rate[1]);
      if (/mono/.test(line)) info.channels = 1;
      else if (/stereo/.test(line)) info.channels = 2;
      else {
        var ch = /(\d+)\s*channels/.exec(line);
        if (ch) info.channels = Number(ch[1]);
      }
      var depth = /pcm_[fsu]?(16|24|32)|s(16|24|32)|f(32|64)|fltp|dblp/.exec(line);
      if (/fltp|f32|pcm_f32|dblp/.test(line)) info.float = true;
      if (depth && depth[1]) info.bits = Number(depth[1]);
      else if (depth && depth[2]) info.bits = Number(depth[2]);
      else if (/s16/.test(line)) info.bits = 16;
      else if (/s32|s24/.test(line)) info.bits = /s24/.test(line) ? 24 : 32;
    }
    if (info.audio && !info.channels) info.channels = 2;
    return info;
  }

  function safeBase(name) {
    var base = String(name || "audio").replace(/\.[^.]+$/, "");
    base = base.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return base || "audio";
  }

  function clock(seconds) {
    var n = Math.max(0, Math.round(Number(seconds) || 0));
    var m = Math.floor(n / 60);
    var s = n % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function bytesLabel(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + " KB";
    if (v < 1024 * 1024 * 1024) return (v / (1024 * 1024)).toFixed(v < 10 * 1024 * 1024 ? 1 : 0) + " MB";
    return (v / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function filters(probe, opt) {
    var depth = opt.depth || "orig";
    var rate = Number(opt.rate) || 0;
    var channels = Number(opt.channels) || 0;
    var srcBits = probe.bits || (probe.float ? 32 : 16);
    var dstBits = depth === "16" ? 16 : depth === "24" ? 24 : depth === "32f" ? 32 : srcBits;
    var reducing = depth !== "orig" && depth !== "32f" && dstBits < srcBits;
    if (probe.float && depth !== "orig" && depth !== "32f") reducing = true;
    var needRate = rate > 0 && probe.rate && rate !== probe.rate;
    var needCh = channels > 0 && probe.channels && channels !== probe.channels;
    if (!needRate && !needCh && !reducing && depth !== "16" && depth !== "24" && depth !== "32f") return "";
    var parts = ["aresample="];
    if (opt.soxr && (needRate || reducing)) parts.push("resampler=soxr:precision=28:");
    else parts.push("resampler=swr:filter_size=256:phase_shift=14:precision=33:cutoff=0.97:");
    if (needRate) parts.push("osr=" + rate + ":");
    if (needCh) parts.push("och=" + channels + ":");
    if (reducing || depth === "16" || depth === "24") parts.push("dither_method=triangular:");
    if (depth === "16") parts.push("osf=s16:");
    else if (depth === "24") parts.push("osf=s32:");
    else if (depth === "32f") parts.push("osf=flt:");
    return parts.join("").replace(/:$/, "");
  }

  function codecArgs(probe, opt) {
    var format = opt.voice ? "voice" : String(opt.format || "flac");
    var spec = FORMATS[format] || FORMATS.flac;
    var depth = opt.depth || "orig";
    var bits = depth === "16" ? 16 : depth === "24" ? 24 : depth === "32f" ? 32 : (probe.bits || 16);
    if (depth === "orig" && (!probe.bits || probe.float) && format !== "voice") bits = probe.float ? 16 : (probe.bits || 16);
    var args = [];
    if (format === "voice") {
      var rate = opt.voiceRate === "48k" ? "48k" : "64k";
      args.push("-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", rate, "-vbr", "on", "-application", "voip", "-frame_duration", "20", "-map_metadata", "-1");
      return { args: args, spec: spec, cover: false };
    }
    if (format === "wav") {
      args.push("-c:a", bits >= 32 && depth === "32f" ? "pcm_f32le" : bits >= 24 ? "pcm_s24le" : "pcm_s16le");
    } else if (format === "aiff") {
      args.push("-c:a", depth === "32f" ? "pcm_f32be" : bits >= 24 ? "pcm_s24be" : "pcm_s16be");
    } else if (format === "flac") {
      var level = Math.max(0, Math.min(12, Number(opt.flac) || 8));
      args.push("-c:a", "flac", "-compression_level", String(level), "-sample_fmt", bits >= 24 && depth !== "16" ? "s32" : "s16");
    } else if (format === "alac") {
      args.push("-c:a", "alac");
    } else if (format === "mp3") {
      args.push("-c:a", "libmp3lame");
      if (opt.mp3 === "v0") args.push("-q:a", "0");
      else args.push("-b:a", "320k");
      args.push("-id3v2_version", "3");
    } else if (format === "aac") {
      args.push("-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart");
    } else if (format === "opus") {
      args.push("-c:a", "libopus", "-b:a", "256k", "-vbr", "on");
    } else if (format === "vorbis") {
      args.push("-c:a", "libvorbis", "-q:a", "10");
    } else {
      args.push("-c:a", "flac", "-compression_level", "8");
    }
    return { args: args, spec: spec, cover: !opt.voice && opt.cover !== false && !!probe.hasCover };
  }

  function argsFor(probe, opt, input, output) {
    var chosen = codecArgs(probe || {}, opt || {});
    var args = ["-i", input, "-map", "0:a:0"];
    if (!opt || !opt.voice) args.push("-map_metadata", "0");
    if (chosen.cover) args.push("-map", "0:v?");
    var chain = (!opt || !opt.voice) ? filters(probe || {}, opt || {}) : "";
    if (opt && opt.voice) {
      /* Voice args already force mono and 48 kHz. */
    }
    if (chain) args.push("-af", chain);
    args = args.concat(chosen.args);
    if (chosen.cover) args.push("-c:v", "copy", "-disposition:v:0", "attached_pic");
    else if (!opt || !opt.voice) args.push("-vn");
    args.push(output);
    return { args: args, ext: chosen.spec.ext, mime: chosen.spec.mime, lossy: chosen.spec.lossy };
  }

  function crc32(bytes) {
    if (!crc32.table) {
      var table = new Uint32Array(256);
      for (var n = 0; n < 256; n += 1) {
        var c = n;
        for (var k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
      crc32.table = table;
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) crc = crc32.table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(n) { return [n & 255, (n >>> 8) & 255]; }
  function u32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }

  function zipStore(files) {
    var locals = [];
    var central = [];
    var offset = 0;
    for (var i = 0; i < files.length; i += 1) {
      var nameBytes = new TextEncoder().encode(String(files[i].name || "audio").slice(0, 180));
      var data = files[i].bytes;
      var crc = crc32(data);
      var local = [].concat([0x50, 0x4b, 0x03, 0x04], u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0));
      locals.push(new Uint8Array(local));
      locals.push(nameBytes);
      locals.push(data);
      var cen = [].concat([0x50, 0x4b, 0x01, 0x02], u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      central.push(new Uint8Array(cen));
      central.push(nameBytes);
      offset += local.length + nameBytes.length + data.length;
    }
    var centralSize = 0;
    central.forEach(function (part) { centralSize += part.length; });
    var end = [].concat([0x50, 0x4b, 0x05, 0x06], u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0));
    var all = locals.concat(central, [new Uint8Array(end)]);
    var total = 0;
    all.forEach(function (part) { total += part.length; });
    var out = new Uint8Array(total);
    var at = 0;
    all.forEach(function (part) { out.set(part, at); at += part.length; });
    return out;
  }

  root.AudioConvertPlan = {
    FORMATS: FORMATS,
    parseProbe: parseProbe,
    safeBase: safeBase,
    clock: clock,
    bytesLabel: bytesLabel,
    argsFor: argsFor,
    zipStore: zipStore
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
