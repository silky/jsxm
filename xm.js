var _note_names = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
var f_smp = 44100;  // updated by play callback, default value here

audioContext = window.AudioContext || window.webkitAudioContext;

function prettify_note(note) {
  if (note < 0) return "---";
  if (note == 96) return "^^^";
  return _note_names[note%12] + ~~(note/12);
}

function prettify_number(num) {
  if (num == -1) return "--";
  if (num < 10) return "0" + num;
  return num;
}

function prettify_volume(num) {
  if (num < 0x10) return "--";
  return num.toString(16);
}

function prettify_effect(t, p) {
  t = t.toString(16);
  if (p < 16) p = '0' + p.toString(16);
  else p = p.toString(16);
  return t + p
}

function prettify_notedata(note, inst, vol, efftype, effparam) {
  return (prettify_note(note) + " " + prettify_number(inst) + " "
    + prettify_volume(vol) + " "
    + prettify_effect(efftype, effparam));
}

function getstring(dv, offset, len) {
  var str = [];
  for (var i = offset; i < offset+len; i++) {
    var c = dv.getUint8(i);
    if (c == 0) break;
    str.push(String.fromCharCode(c));
  }
  return str.join('');
}

var channelinfo = [];
var instruments = [];
var tempo = 4;

// Return 2-pole Butterworth lowpass filter coefficients for
// center frequncy f_c (relative to sampling frequency)
function FilterCoeffs(f_c) {
  //  if (f_c > 0.5) {  // we can't lowpass above the nyquist frequency...
  //    return [1, 0, 0];
  //  }
  //  what happens instead is the filter wraps around to an alias frequency,
  //  and that also works OK, though it isn't strictly right... FIXME
  var wct = Math.sqrt(2) * Math.PI * f_c;
  var e = Math.exp(-wct);
  var c = e * Math.cos(wct);
  var s = e * Math.sin(wct);
  var gain = (1 - 2*c + c*c + s*s) / 2;
  return [gain, 2*c, -c*c - s*s];
}

popfilter = FilterCoeffs(200.0 / 44100.0);
popfilter_alpha = 0.9837;

function UpdateChannelPeriod(ch, period) {
  var freq = 8363 * Math.pow(2, (1152.0 - period) / 192.0);
  ch.doff = freq / f_smp;
  ch.filter = FilterCoeffs(ch.doff / 2);
}

function PeriodForNote(ch, note) {
  return 1920 - note*16 - ch.inst.fine / 8.0;
}

var cur_songpos = -1, cur_pat = -1, cur_row = 64, cur_ticksamp = 0;
var cur_tick = 6;
var patdisplay = [];
function next_row() {
  if (cur_pat == -1 || cur_row >= patterns[cur_pat].length) {
    cur_row = 0;
    cur_songpos++;
    if (cur_songpos >= songpats.length)
      cur_songpos = song_looppos;
    cur_pat = songpats[cur_songpos];
  }
  var p = patterns[cur_pat];
  var r = p[cur_row];
  cur_row++;
  pretty_row = [];
  for (var i = 0; i < r.length; i++) {
    var ch = channelinfo[i];
    ch.update = false;
    pretty_row.push(prettify_notedata(r[i][0], r[i][1], r[i][2], r[i][3], r[i][4]));
    // instrument trigger
    if (r[i][1] != -1) {
      var inst = instruments[r[i][1] - 1];
      if (inst != undefined) {
        ch.inst = inst;
        // retrigger unless overridden below
        triggernote = true;
        // new instrument doesn ot reset volume!
      } else {
        // console.log("invalid inst", r[i][1], instruments.length);
      }
    }
    var triggernote = false;
    // note trigger
    if (r[i][0] != -1) {
      if (r[i][0] == 96) {
        // release note, FIXME once envelopes are implemented
        ch.release = 1;
      } else {
        // assume linear frequency table (flags header & 1 == 1)
        // is this true in kamel.xm?
        var inst = ch.inst;
        if (inst != undefined) {
          var note = r[i][0] + inst.note;
          ch.note = note;
          triggernote = true;
          // if there's an instrument and a note, set the volume
          ch.pan = inst.pan;
          ch.vol = inst.vol;
        }
      }
    }
    if (r[i][2] != -1) {  // volume column
      // FIXME: panning
      var v = r[i][2];
      if (v < 0x10) {
        console.log("channel", i, "invalid volume", v.toString(16));
      } else if (v <= 0x50) {
        ch.vol = v - 0x10;
      } else if (v >= 0x80 && v < 0x90) {  // fine volume slide down
        ch.vol = Math.max(0, ch.vol - (v & 0x0f));
      } else if (v >= 0x90 && v < 0xa0) {  // fine volume slide up
        ch.vol = Math.min(64, ch.vol + (v & 0x0f));
      } else if (v >= 0xc0 && v < 0xd0) {  // set panning
        ch.pan = (v & 0x0f) * 0x11;
      } else {
        console.log("channel", i, "volume effect", v.toString(16));
      }
    }

    ch.effect = r[i][3];
    ch.effectdata = r[i][4];
    if (ch.effect < 16) {
      ch.effectfn = effects_t1[ch.effect];
      if (effects_t0[ch.effect](ch, ch.effectdata)) {
        triggernote = false;
      }
    } else {
      console.log("channel", i, "effect > 16", ch.effect);
    }

    // special handling for portamentos: don't trigger the note
    if (ch.effect == 3 || ch.effect == 5) {
      if (r[i][0] != -1) {
        ch.periodtarget = PeriodForNote(ch, ch.note);
      }
      triggernote = false;
      if (ch.release && inst != undefined) {
        // reset envelopes if note was released but leave offset/pitch/etc
        // alone
        ch.envtick = 0;
        ch.release = 0;
        ch.env_vol = new EnvelopeFollower(inst.env_vol);
        ch.env_pan = new EnvelopeFollower(inst.env_pan);
      }
    }

    if (triggernote) {
      ch.off = 0;
      ch.release = 0;
      ch.envtick = 0;
      ch.vibratopos = 0;
      ch.env_vol = new EnvelopeFollower(inst.env_vol);
      ch.env_pan = new EnvelopeFollower(inst.env_pan);
      ch.period = PeriodForNote(ch, note);
    }
  }
  patdisplay.push(pretty_row.join("  "));
  if (patdisplay.length > 16) {
    patdisplay.shift();
  }
}

function Envelope(points, type, sustain, loopstart, loopend) {
  this.points = points;
  this.type = type;
  this.sustain = sustain;
  this.loopstart = loopstart;
  this.loopend = loopend;
}

Envelope.prototype.Get = function(ticks) {
  // TODO: optimize follower with ptr
  // or even do binary search here
  var y0;
  var env = this.points;
  for (var i = 0; i < env.length; i += 2) {
    y0 = env[i+1];
    if (ticks < env[i]) {
      var x0 = env[i-2];
      var y0 = env[i-1];
      var dx = env[i] - x0;
      var dy = env[i+1] - y0;
      return y0 + (ticks - x0) * dy / dx;
    }
  }
  return y0;
}

function EnvelopeFollower(env) {
  this.env = env;
  this.tick = 0;
}

EnvelopeFollower.prototype.Tick = function(release, defaultval) {
  if (this.env === undefined) {
    return defaultval;
  }
  var value = this.env.Get(this.tick);
  if (this.env.type & 1) {  // sustain?
    // if we're sustaining a note, stop advancing the tick counter
    if (!release &&
        this.tick >= this.env.points[this.env.sustain*2]) {
      return this.env.points[this.env.sustain*2 + 1];
    }
  }
  this.tick++;
  if (this.env.type & 2) {  // envelope loop?
    if (!release &&
        this.tick > this.env.loopend) {
      this.tick -= this.env.loopend - this.env.loopstart;
    }
  }
  return value;
}

function next_tick() {
  cur_tick++;
  if (cur_tick >= tempo) {
    cur_tick = 0;
    next_row();
  }
  for (var j = 0; j < nchan; j++) {
    var ch = channelinfo[j];
    var inst = ch.inst;
    ch.periodoffset = 0;
    if (cur_tick != 0 && ch.effectfn) {
      ch.effectfn(ch);
    }
    if (inst === undefined) continue;
    ch.volE = ch.env_vol.Tick(ch.release, 64);
    ch.panE = ch.env_pan.Tick(ch.release, 32);
    UpdateChannelPeriod(ch, ch.period + ch.periodoffset);
  }
}

// This function gradually brings the channel back down to zero if it isn't
// already to avoid clicks and pops when samples end.
function MixSilenceIntoBuf(ch, start, end, dataL, dataR) {
  var s = ch.filterstate[1];
  if (isNaN(s)) {
    console.log("NaN filterstate?", ch.filterstate, ch.filter);
    return;
  }
  for (var i = start; i < end; i++) {
    if (Math.abs(s) < 1.526e-5) {  // == 1/65536.0
      s = 0;
      break;
    }
    dataL[i] += s * ch.vL;
    dataR[i] += s * ch.vR;
    s *= popfilter_alpha;
  }
  ch.filterstate[1] = s;
  ch.filterstate[2] = s;
  if (isNaN(s)) {
    console.log("NaN filterstate after adding silence?", ch.filterstate, ch.filter, i);
    return;
  }
  return 0;
}

function MixChannelIntoBuf(ch, start, end, dataL, dataR) {
  var inst = ch.inst;
  var samp, sample_end;
  var loop = false;
  var looplen = 0;

  // nothing on this channel, just filter the last dc offset back down to zero
  if (inst == undefined || ch.mute) {
    return MixSilenceIntoBuf(ch, start, end, dataL, dataR);
  }

  samp = inst.sampledata;
  sample_end = inst.len;
  if ((inst.type & 3) == 1) { // todo: support pingpong
    loop = true;
    looplen = inst.looplen;
    sample_end = looplen + inst.loop;
  }
  var samplen = inst.len;
  var volE = ch.volE / 64.0;    // current volume envelope
  var panE = 4*(ch.panE - 32);  // current panning envelope
  var p = panE + ch.pan - 128;  // final pan
  var volL = volE * (128 - p) * ch.vol / 8192.0;
  var volR = volE * (128 + p) * ch.vol / 8192.0;
  if (volL < 0) volL = 0;
  if (volR < 0) volR = 0;
  if (volR == 0 && volL == 0)
    return;
  if (isNaN(volR) || isNaN(volL)) {
    console.log("NaN volume!?", volL, volR, colE, panE, ch.vol);
    return;
  }
  var k = ch.off;
  var dk = ch.doff;
  var Vrms = 0;
  for (var i = start; i < end; i++) {
    if (k >= sample_end) {  // TODO: implement pingpong looping
      if (loop) {
        k %= looplen;
      } else {
        // kill sample
        ch.inst = undefined;
        // fill rest of buf with filtered dc offset using loop above
        return Vrms + MixSilenceIntoBuf(ch, i+1, end, dataL, dataR);
      }
    }
    var s = samp[k|0];
    // TODO: robustify, then remove these NaN checks from the inner loops
    if (isNaN(s)) {
      console.log("NaN sample idx", samp.length, k|0);
      tempo = 10000;
      break;
    }
    // we low-pass filter here since we are resampling some arbitrary
    // frequency to f_smp; this is an anti-aliasing filter and is
    // implemented as an IIR butterworth filter (usually we'd use an FIR
    // brick wall filter, but this is much simpler computationally and
    // sounds fine)
    var si = ch.filter[0] * (s + ch.filterstate[0]) +
      ch.filter[1]*ch.filterstate[1] + ch.filter[2]*ch.filterstate[2];
    if (isNaN(si)) {
      console.log("NaN after filter sample idx", samp, k|0, ch.filter, ch.filterstate, s);
      break;
    }
    ch.filterstate[2] = ch.filterstate[1];
    ch.filterstate[1] = si; ch.filterstate[0] = s;
    // we also low-pass filter volume changes with a simple one-zero,
    // one-pole filter to avoid pops and clicks when volume changes.
    ch.vL = popfilter_alpha * ch.vL + (1 - popfilter_alpha) * (volL + ch.vLprev) * 0.5;
    ch.vR = popfilter_alpha * ch.vR + (1 - popfilter_alpha) * (volR + ch.vRprev) * 0.5;
    ch.vLprev = volL;
    ch.vRprev = volR;
    dataL[i] += ch.vL * si;
    dataR[i] += ch.vR * si;
    Vrms += (ch.vL + ch.vR) * si * si;
    k += dk;
  }
  ch.off = k;
  ch.doff = dk;
  return Vrms * 0.5;
}

function audio_cb(e) {
  f_smp = audioctx.sampleRate;
  var buflen = e.outputBuffer.length;
  var dataL = e.outputBuffer.getChannelData(0);
  var dataR = e.outputBuffer.getChannelData(1);

  // backward compat w/ no array.fill
  if (dataL.fill === undefined) {
    for (var i = 0; i < buflen; i++) {
      dataL[i] = 0;
      dataR[i] = 0;
    }
  } else {
    dataL.fill(0);
    dataR.fill(0);
  }

  var offset = 0;
  var ticklen = 0|(f_smp * 2.5 / bpm);
  var VU = new Float32Array(nchan);

  while(buflen > 0) {
    if (cur_ticksamp >= ticklen) {
      next_tick(f_smp);
      cur_ticksamp -= ticklen;
    }
    var tickduration = Math.min(buflen, ticklen - cur_ticksamp);
    for (var j = 0; j < nchan; j++) {
      VU[j] += MixChannelIntoBuf(
          channelinfo[j], offset, offset + tickduration, dataL, dataR);
    }
    offset += tickduration;
    cur_ticksamp += tickduration;
    buflen -= tickduration;
  }

  // update VU meters
  var canvas = document.getElementById("vu");
  var ctx = canvas.getContext("2d");
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 300, 64);
  ctx.fillStyle = '#0f0';
  for (var j = 0; j < nchan; j++) {
    var rms = VU[j] / e.outputBuffer.length;
    var y = -Math.log(rms)*10;
    ctx.fillRect(j*16, y, 15, 64-y);
  }

  var debug = document.getElementById("debug");
  debug.innerHTML = 'pat ' + cur_pat + ' row ' + (cur_row-1);
  var pat = document.getElementById("pattern");
  pat.innerHTML = patdisplay.join("\n");
}

function eff_t0_0(ch, data) {  // arpeggio
  // nothing to do here, arpeggio will be done on ch.effectdata
}

function eff_t0_1(ch, data) {  // pitch slide up
  if (data != 0) {
    ch.slideupspeed = data;
  }
}

function eff_t0_2(ch, data) {  // pitch slide down
  if (data != 0) {
    ch.slidedownspeed = data;
  }
}

function eff_t0_3(ch, data) {  // portamento
  if (data != 0) {
    ch.portaspeed = data;
  }
}

function eff_t0_4(ch, data) {  // vibrato
  if (data & 0x0f) {
    ch.vibratodepth = data & 0x0f;
  }
  if (data >> 4) {
    ch.vibratospeed = data >> 4;
  }
  eff_t1_4(ch, data);
}

function eff_t0_8(ch, data) {  // set panning
  ch.pan = data;
}

function eff_t0_9(ch, data) {  // sample offset
  ch.off = data * 256;
}

function eff_t0_a(ch, data) {  // volume slide
  if (data) {
    if (data & 0x0f) {
      ch.volumeslide = -(data & 0x0f);
    } else {
      ch.volumeslide = data >> 4;
    }
  }
}

function eff_t0_b(ch, data) {  // song jump (untested)
  if (data < songpats.length) {
    cur_songpos = data
    cur_pat = songpats[cur_songpos];
  }
}

function eff_t0_c(ch, data) {  // set volume
  ch.vol = data & 0x3f;
}

function eff_t0_d(ch, data) {  // pattern jump
  cur_songpos++;
  if (cur_songpos >= songpats.length)
    cur_songpos = song_looppos;
  cur_pat = songpats[cur_songpos];
  cur_row = data;
}

function eff_t0_e(ch, data) {  // extended effects!
  var eff = data >> 4;
  data = data & 0x0f;
  switch (eff) {
    case 1:  // fine porta up
      ch.period -= data;
      break;
    case 2:  // fine porta down
      ch.period += data;
      break;
    case 8:  // panning
      ch.pan = data * 0x11;
      break;
    case 0x0a:  // fine vol slide up (with memory)
      if (data == 0 && ch.finevolup != undefined)
        data = ch.finevolup;
      ch.vol = Math.min(64, ch.vol + data);
      ch.finevolup = data;
      break;
    case 0x0b:  // fine vol slide down
      if (data == 0 && ch.finevoldown != undefined)
        data = ch.finevoldown;
      ch.vol = Math.max(0, ch.vol - data);
      ch.finevoldown = data;
      break;
    case 0x0c:  // note cut handled in eff_t1_e
      break;
    default:
      console.log("unimplemented extended effect E", ch.effect.toString(16));
      break;
  }
}

function eff_t0_f(ch, data) {  // set tempo
  if (data == 0) {
    console.log("tempo 0?");
    return;
  } else if(data < 0x20) {
    tempo = data;
  } else {
    bpm = data;
  }
}

function eff_unimplemented_t0(ch, data) {
  console.log("unimplemented effect", ch.effect.toString(16), data.toString(16));
}

var effects_t0 = [  // effect functions on tick 0
  eff_t0_0,
  eff_t0_1,
  eff_t0_2,
  eff_t0_3,
  eff_t0_4,  // 4
  eff_t0_a,  // 5, same as A on first tick
  eff_t0_a,  // 6, same as A on first tick
  eff_unimplemented_t0,  // 7
  eff_t0_8,  // 8
  eff_t0_9,  // 9
  eff_t0_a,  // a
  eff_t0_b,  // b
  eff_t0_c,  // c
  eff_t0_d,  // d
  eff_t0_e,  // e
  eff_t0_f,  // f
];

function eff_t1_0(ch) {  // arpeggio
  if (ch.effectdata != 0 && ch.inst != undefined) {
    var arpeggio = [0, ch.effectdata>>4, ch.effectdata&15];
    var note = ch.note + arpeggio[cur_tick % 3];
    ch.period = PeriodForNote(ch, note);
  }
}

function eff_t1_1(ch) {  // pitch slide up
  if (ch.slideupspeed !== undefined) {
    // is this limited? it appears not
    ch.period -= ch.slideupspeed;
  }
}

function eff_t1_2(ch) {  // pitch slide down
  if (ch.slidedownspeed !== undefined) {
    // 1728 is the period for C-1
    ch.period = Math.min(1728, ch.period + ch.slidedownspeed);
  }
}

function eff_t1_3(ch) {  // portamento
  if (ch.periodtarget !== undefined && ch.portaspeed !== undefined) {
    if (ch.period > ch.periodtarget) {
      ch.period = Math.max(ch.periodtarget, ch.period - ch.portaspeed);
    } else {
      ch.period = Math.min(ch.periodtarget, ch.period + ch.portaspeed);
    }
  }
}

function eff_t1_4(ch) {  // vibrato
  ch.periodoffset = Math.sin(ch.vibratopos * Math.PI / 32) * ch.vibratodepth;
  ch.vibratopos += ch.vibratospeed;
  ch.vibratopos &= 63;
}

function eff_t1_5(ch) {  // portamento + volume slide
  eff_t1_a(ch);
  eff_t1_3(ch);
}

function eff_t1_6(ch) {  // vibrato + volume slide
  eff_t1_a(ch);
  eff_t1_4(ch);
}

function eff_t1_a(ch) {  // volume slide
  if (ch.volumeslide !== undefined) {
    ch.vol = Math.max(0, Math.min(64, ch.vol + ch.volumeslide));
  }
}

function eff_t1_e(ch) {  // note cut
  switch (ch.effectdata >> 4) {
    case 0x0c:
      if (cur_tick == (ch.effectdata & 0x0f)) {
        ch.vol = 0;
      }
      break;
  }
}

function eff_nop() {}
function eff_unimplemented() {}
var effects_t1 = [  // effect functions on tick 1+
  eff_t1_0,
  eff_t1_1,
  eff_t1_2,
  eff_t1_3,
  eff_t1_4,
  eff_t1_5,  // 5
  eff_t1_6,  // 6
  eff_unimplemented,  // 7
  eff_nop,   // 8
  eff_nop,   // 9
  eff_t1_a,  // a
  eff_nop,   // b
  eff_nop,   // c
  eff_nop,   // d
  eff_t1_e,  // e
  eff_nop,   // f
];

function ConvertSample(array, bits) {
  var len = array.length;
  var acc = 0;
  if (bits == 0) {  // 8 bit sample
    var samp = new Float32Array(len);
    for (var k = 0; k < len; k++) {
      acc += array[k];
      var b = acc&255;
      if (b & 128) b = b-256;
      samp[k] = b / 128.0;
    }
    return samp;
  } else {
    len /= 2;
    var samp = new Float32Array(len);
    for (var k = 0; k < len; k++) {
      acc += array[k*2] + (array[k*2 + 1] << 8);
      var b = acc&65535;
      if (b & 32768) b = b-65536;
      samp[k] = b / 32768.0;
    }
    return samp;
  }
}

function UnrollSampleLoop(inst) {
  var nloops = ((2048 + inst.looplen - 1) / inst.looplen) | 0;
  var pingpong = inst.type & 2;
  if (pingpong) {
    // make sure we have an even number of loops if we are pingponging
    nloops = (nloops + 1) & (~1);
  }
  var samplesiz = inst.loop + nloops * inst.looplen;
  var samp = new Float32Array(samplesiz);
  for (var i = 0; i < inst.loop; i++) {
    samp[i] = inst.sampledata[i];
  }
  for (var j = 0; j < nloops; j++) {
    if (j&1 && pingpong) {
      for (var k = inst.looplen - 1; k >= 0; k--) {
        samp[i++] = inst.sampledata[inst.loop + k];
      }
    } else {
      for (var k = 0; k < inst.looplen; k++) {
        samp[i++] = inst.sampledata[inst.loop + k];
      }
    }
  }
  inst.sampledata = samp;
  inst.looplen = nloops * inst.looplen;
  inst.type &= ~2;
}

function playXM(arrayBuf) {
  var dv = new DataView(arrayBuf);
  window.dv = dv;

  var name = getstring(dv, 17, 20);
  var hlen = dv.getUint32(0x3c, true) + 0x3c;
  var songlen = dv.getUint16(0x40, true);
  song_looppos = dv.getUint16(0x42, true);
  nchan = dv.getUint16(0x44, true);
  var npat = dv.getUint16(0x46, true);
  var ninst = dv.getUint16(0x48, true);
  var flags = dv.getUint16(0x4a, true);
  tempo = dv.getUint16(0x4c, true);
  bpm = dv.getUint16(0x4e, true);
  for (var i = 0; i < nchan; i++) {
    channelinfo.push({
      filterstate: new Float32Array(3),
      popfilter: FilterCoeffs(200.0 / 44100.0),
      popfilterstate: [new Float32Array(3), new Float32Array(3)],
      vol: 0,
      pan: 128,
      vL: 0, vR: 0,   // left right volume envelope followers (changes per sample)
      vLprev: 0, vRprev: 0,
      mute: 0,
      volE: 0, panE: 0,
      vibratodepth: 1,
      vibratospeed: 1,
    })
  }
  console.log("header len " + hlen);

  console.log("songlen %d, %d channels, %d patterns, %d instruments", songlen, nchan, npat, ninst);
  console.log("loop @%d", song_looppos);
  console.log("flags=%d tempo %d bpm %d", flags, tempo, bpm);

  songpats = [];
  for (var i = 0; i < songlen; i++) {
    songpats.push(dv.getUint8(0x50 + i));
  }
  console.log("song patterns: ", songpats);

  var idx = hlen;
  patterns = [];
  for (var i = 0; i < npat; i++) {
    var pattern = [];
    var patheaderlen = dv.getUint32(idx, true);
    var patrows = dv.getUint16(idx + 5, true);
    var patsize = dv.getUint16(idx + 7, true);
    console.log("pattern %d: %d bytes, %d rows", i, patsize, patrows);
    idx += 9;
    for (var j = 0; patsize > 0 && j < patrows; j++) {
      row = [];
      pretty_row = [];
      for (var k = 0; k < nchan; k++) {
        var byte0 = dv.getUint8(idx); idx++;
        var note = -1, inst = -1, vol = -1, efftype = 0, effparam = 0;
        if (byte0 & 0x80) {
          if (byte0 & 0x01) {
            note = dv.getUint8(idx) - 1; idx++;
          }
          if (byte0 & 0x02) {
            inst = dv.getUint8(idx); idx++;
          }
          if (byte0 & 0x04) {
            vol = dv.getUint8(idx); idx++;
          }
          if (byte0 & 0x08) {
            efftype = dv.getUint8(idx); idx++;
          }
          if (byte0 & 0x10) {
            effparam = dv.getUint8(idx); idx++;
          }
        } else {
          // byte0 is note from 1..96 or 0 for nothing or 97 for release
          // so we subtract 1 so that C-0 is stored as 0
          note = byte0 - 1;
          inst = dv.getUint8(idx); idx++;
          vol = dv.getUint8(idx); idx++;
          efftype = dv.getUint8(idx); idx++;
          effparam = dv.getUint8(idx); idx++;
        }
        pretty_row.push(prettify_notedata(note, inst, vol, efftype, effparam));
        row.push([note, inst, vol, efftype, effparam]);
      }
      pattern.push(row);
    }
    patterns.push(pattern);
  }

  // now load instruments
  for (i = 0; i < ninst; i++) {
    var hdrsiz = dv.getUint32(idx, true);
    var instname = getstring(dv, idx+0x4, 22);
    var nsamp = dv.getUint16(idx+0x1b, true);
    if (nsamp > 0) {
      var env_nvol = dv.getUint8(idx+225);
      var env_vol_type = dv.getUint8(idx+233);
      var env_vol_sustain = dv.getUint8(idx+227);
      var env_vol_loop_start = dv.getUint8(idx+228);
      var env_vol_loop_end = dv.getUint8(idx+229);
      var env_npan = dv.getUint8(idx+226);
      var env_pan_type = dv.getUint8(idx+234);
      var env_pan_sustain = dv.getUint8(idx+230);
      var env_pan_loop_start = dv.getUint8(idx+231);
      var env_pan_loop_end = dv.getUint8(idx+232);
      var env_vol = [];
      for (var j = 0; j < env_nvol*2; j++) {
        env_vol.push(dv.getUint16(idx+129+j*2, true));
      }
      var env_pan = [];
      for (var j = 0; j < env_npan*2; j++) {
        env_pan.push(dv.getUint16(idx+177+j*2, true));
      }
      // FIXME: ignoring keymaps for now and assuming 1 sample / instrument
      // var keymap = getarray(dv, idx+0x21);
      var samphdrsiz = dv.getUint32(idx+0x1d, true);
      console.log("hdrsiz %d; instrument %d: '%s' %d samples, samphdrsiz %d",
          hdrsiz, i, instname, nsamp, samphdrsiz);
      idx += hdrsiz;
      var totalsamples = 0;
      for (var j = 0; j < nsamp; j++) {
        var samplen = dv.getUint32(idx, true);
        var samploop = dv.getUint32(idx+4, true);
        var samplooplen = dv.getUint32(idx+8, true);
        var sampvol = dv.getUint8(idx+12);
        var sampfinetune = dv.getInt8(idx+13);
        var samptype = dv.getUint8(idx+14);
        var samppan = dv.getUint8(idx+15);
        var sampnote = dv.getInt8(idx+16);
        var sampname = getstring(dv, idx+18, 22);
        var sampleoffset = idx + samphdrsiz;
        console.log("sample %d: len %d name '%s' loop %d/%d vol %d",
            j, samplen, sampname, samploop, samplooplen, sampvol);
        console.log("           type %d note %s(%d) finetune %d pan %d",
            samptype, prettify_note(sampnote + 12*4), sampnote, sampfinetune, samppan);
        console.log("           vol env", env_vol, env_vol_sustain,
            env_vol_loop_start, env_vol_loop_end, "type", env_vol_type);
        console.log("           pan env", env_pan, env_pan_sustain,
            env_pan_loop_start, env_pan_loop_end, "type", env_pan_type);
        idx += samphdrsiz;
        totalsamples += samplen;
      }
      idx += totalsamples;
      inst = {
        'name': instname,
        'len': samplen, 'loop': samploop,
        'looplen': samplooplen, 'note': sampnote, 'fine': sampfinetune,
        'pan': samppan, 'type': samptype, 'vol': sampvol,
        'fine': sampfinetune,
        'sampledata': ConvertSample(new Uint8Array(arrayBuf, sampleoffset, samplen), samptype & 16),
      };
      if (samptype & 16) {
        inst.len /= 2;
        inst.loop /= 2;
        inst.looplen /= 2;
      }

      // unroll short loops and any pingpong loops
      if ((inst.type & 1) && (inst.looplen < 2048 || (inst.type & 2))) {
        UnrollSampleLoop(inst);
      }

      if (env_vol_type) {
        inst.env_vol = new Envelope(
            env_vol,
            env_vol_type,
            env_vol_sustain,
            env_vol_loop_start,
            env_vol_loop_end);
      }
      if (env_pan_type) {
        inst.env_pan = new Envelope(
            env_pan,
            env_pan_type,
            env_pan_sustain,
            env_pan_loop_start,
            env_pan_loop_end);
      }
      instruments.push(inst);
    } else {
      idx += hdrsiz;
      console.log("empty instrument", i, hdrsiz, idx);
      instruments.push(null);
    }
  }

  audioctx = new audioContext();
  gainNode = audioctx.createGain();
  gainNode.gain.value = 0.1;  // master volume
  jsNode = audioctx.createScriptProcessor(4096, 0, 2);
  jsNode.onaudioprocess = audio_cb;
  jsNode.connect(gainNode);

  var debug = document.getElementById("debug");
  console.log("loaded \"" + name + "\"");
  debug.innerHTML = name;

  // start playing
  gainNode.connect(audioctx.destination);
}

var xmReq = new XMLHttpRequest();
var uri = location.search.substr(1);
if (uri == "") {
  uri = "kamel.xm";
}
xmReq.open("GET", uri, true);
xmReq.responseType = "arraybuffer";
xmReq.onload = function (xmEvent) {
  var arrayBuffer = xmReq.response;
  if (arrayBuffer) {
    playXM(arrayBuffer);
  }
}
xmReq.send(null);
