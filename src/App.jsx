import { useState, useEffect, useRef, useCallback } from "react";
import { Volume2, VolumeX } from "lucide-react";

const W = 400;
const H = 500;
const BIRD_X = 80;
const BIRD_R = 14;
const GRAVITY = 0.3;
const JUMP = -8;
const PIPE_W = 52;
const GAP = 170;
const PIPE_SPEED = 2.5;
const PIPE_INTERVAL = 210;
const POWERUP_R = 12;
const POWERUP_INTERVAL_MIN = 380;
const POWERUP_INTERVAL_MAX = 620;
const INVINCIBLE_FRAMES = 300; // ~5 seconds at 60fps
const HOVER_FRAMES = 4; // ~0.07s pause at the top of the jump before gravity resumes

// ---- Coins ----
const COIN_R = 9;
const COIN_SPAWN_CHANCE = 0.55; // per-pipe chance of a regular coin appearing in its gap
const GOLDEN_COIN_EVERY_MIN = 40; // golden coin shows up roughly once every 40-50 pipes
const GOLDEN_COIN_EVERY_MAX = 50;
const GOLDEN_COIN_VALUE = 10;
const COIN_VALUE = 1;

// ---- Coin waves: a pipe-free burst of coins, triggered every WAVE_SCORE_INTERVAL points ----
const WAVE_SCORE_INTERVAL = 30;
const WAVE_COIN_COUNT = 7;
const WAVE_COIN_SPACING = 50;
const WAVE_AMPLITUDE = 65;
const WAVE_CLEAR_ZONE = 260; // no wave starts until the nearest pipe is at least this far from the spawn edge
const DEATH_GRAVITY = 0.55;
const DEATH_SPIN_SPEED = 0.35; // radians per frame during the death tumble
const DEATH_MAX_FRAMES = 90; // safety cap (~1.5s) in case the bird never reaches the ground

const DAY_CYCLE_FRAMES = 2700; // ~45s at 60fps for a full day -> night -> day cycle
const BIOMES = ["sky", "garden", "mountain"];
const OBSTACLES_PER_BIOME = 4; // how many obstacles before the scenery shifts
const LAVA_INTERVAL = 130; // frames between lava fountain spawns (mountain biome only) — frequent, ambient danger
const LAVA_W = 30;
const HEADSTART_FRAMES = 240; // ~4 seconds of full phase + levitate

// Sky color keyframes across one day/night cycle: t runs 0 -> 1
const SKY_KEYFRAMES = [
  { t: 0.0, top: [135, 206, 250], bottom: [255, 255, 255] },
  { t: 0.2, top: [255, 145, 110], bottom: [255, 205, 140] },
  { t: 0.42, top: [40, 30, 70], bottom: [90, 55, 95] },
  { t: 0.5, top: [10, 10, 32], bottom: [28, 20, 50] },
  { t: 0.58, top: [40, 30, 70], bottom: [90, 55, 95] },
  { t: 0.8, top: [255, 145, 110], bottom: [255, 205, 140] },
  { t: 1.0, top: [135, 206, 250], bottom: [255, 255, 255] },
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Cartoony "pop" ease with a little overshoot bounce (easeOutBack)
function popEase(t) {
  t = Math.min(1, Math.max(0, t));
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const r = Math.round(lerp(ca[0], cb[0], t));
  const g = Math.round(lerp(ca[1], cb[1], t));
  const bl = Math.round(lerp(ca[2], cb[2], t));
  return `rgb(${r},${g},${bl})`;
}

// How far an off-screen-right entity has revealed itself as it scrolls into view
function edgePop(x, revealZone = 70) {
  if (x >= W) return 0;
  if (x > W - revealZone) return popEase((W - x) / revealZone);
  return 1;
}

const POP_DURATION_FRAMES = 14; // obstacle/power-up spawn pop duration
const BIOME_TRANSITION_FRAMES = 55; // crossfade length when the biome switches

function getSkyColors(dayT) {
  let a = SKY_KEYFRAMES[0];
  let b = SKY_KEYFRAMES[SKY_KEYFRAMES.length - 1];
  for (let i = 0; i < SKY_KEYFRAMES.length - 1; i++) {
    if (dayT >= SKY_KEYFRAMES[i].t && dayT <= SKY_KEYFRAMES[i + 1].t) {
      a = SKY_KEYFRAMES[i];
      b = SKY_KEYFRAMES[i + 1];
      break;
    }
  }
  const span = b.t - a.t || 1;
  const localT = (dayT - a.t) / span;
  const top = a.top.map((c, i) => Math.round(lerp(c, b.top[i], localT)));
  const bottom = a.bottom.map((c, i) => Math.round(lerp(c, b.bottom[i], localT)));
  const nightAmount = (1 - Math.cos(dayT * Math.PI * 2)) / 2;
  return {
    top: `rgb(${top[0]},${top[1]},${top[2]})`,
    bottom: `rgb(${bottom[0]},${bottom[1]},${bottom[2]})`,
    nightAmount,
  };
}

const CHARACTERS = [
  { id: "bird", name: "Bird", desc: "The classic flapper" },
  { id: "dragon", name: "Dragon", desc: "Small fire-breather" },
  { id: "serpent", name: "Serpent", desc: "Feathered sky serpent" },
  { id: "griffin", name: "Griffin", desc: "Eagle-lion hybrid" },
  { id: "unicorn", name: "Unicorn", desc: "Winged and magical" },
];

// Procedurally synthesized ambient loops (no external audio/copyrighted material)
const MUSIC_THEMES = {
  bird: { root: 523.25, wave: "triangle", pattern: [0, 4, 7, 4], stepMs: 380 },
  dragon: { root: 130.81, wave: "sawtooth", pattern: [0, 3, 7, 3], stepMs: 460 },
  serpent: { root: 146.83, wave: "sine", pattern: [0, 3, 6, 3], stepMs: 520 },
  griffin: { root: 196.0, wave: "square", pattern: [0, 4, 7, 12], stepMs: 340 },
  unicorn: { root: 440.0, wave: "sine", pattern: [0, 4, 7, 11], stepMs: 300 },
};

function randomGapY(gap = GAP, maxBottom = H - 60) {
  const minTop = 60;
  // Clamp so the gap's bottom edge never exceeds maxBottom, even if that's
  // tighter than the default screen-based bound (used to keep mountain-biome
  // gaps clear of the lava hazards' max reach — see MOUNTAIN_MAX_GAP_BOTTOM_FOUNTAIN / _PILLAR).
  const safeMaxBottom = Math.max(minTop + gap, Math.min(maxBottom, H - 60));
  const range = Math.max(1, safeMaxBottom - gap - minTop);
  return Math.floor(Math.random() * range) + minTop;
}

// Biome visual themes: obstacle palette + ground accent per biome
const BIOME_THEME = {
  sky: {
    pipeGrad: ["#0f3460", "#1a5276", "#0a2342"],
    cap: "#e94560",
    groundTop: "#0f3460",
    groundAccent: "#e94560",
    label: "Sky",
  },
  garden: {
    pipeGrad: ["#1e8449", "#27ae60", "#145a32"],
    cap: "#7b3f00",
    groundTop: "#1e8449",
    groundAccent: "#f1c40f",
    label: "Garden",
  },
  mountain: {
    pipeGrad: ["#5d4037", "#6d4c41", "#3e2723"],
    cap: "#8d8d8d",
    groundTop: "#4a4a4a",
    groundAccent: "#e74c3c",
    label: "Mountain",
  },
};

const LAVA_LIFE = 150; // frames a lava fountain stays active
const HOVER_BOB_AMPLITUDE = 6;
const HOVER_BOB_SPEED = 0.08;
const HEADSTART_POWERUP_CHANCE = 0.4;
const HEADSTART_SPEED_MULT = 2.6; // world zips by while phasing
const TRAIL_PARTICLE_LIFE = 24;
const DECOR_SPACING = 240;
const HEADSTART_RUNWAY = 340; // px of guaranteed clear space carved out on pickup (legacy, no longer used to teleport obstacles)
const HEADSTART_LANDING_BUFFER = 100; // extra frames after headstart before next obstacle can spawn
const HEADSTART_EASE_FRAMES = 20; // frames to glide into the centered flight path
const HEADSTART_EXIT_EASE_FRAMES = 26; // frames to fade the wave/speed back out before landing
const HEADSTART_WAVE_AMPLITUDE = 26;
const HEADSTART_WAVE_SPEED = 0.11;

function biomeForObstacleIndex(idx) {
  return BIOMES[Math.floor(idx / OBSTACLES_PER_BIOME) % BIOMES.length];
}

// ---- Lava pillar (replaces the old "lava rain" ember weather) ----
const PILLAR_TIER_MIN = 6; // difficulty tier at which pillars start erupting in the mountain biome
const PILLAR_INTERVAL_MIN = 340;
const PILLAR_INTERVAL_MAX = 460;
const PILLAR_W = 46;
const PILLAR_LIFE = 210;
const PILLAR_MAX_HEIGHT = 210;
const PILLAR_WARN_FRAMES = 75; // ~1.25s telegraph before an eruption

const LAVA_MAX_HEIGHT = 150; // peak of the sin curve in lavaHeightAt below
const LAVA_SAFE_MARGIN = 24; // extra buffer above lava's max reach a gap must clear
// Lava hazards spawn on their own timer, independent of pipe placement, so a
// fountain (or pillar) can end up directly under a pipe. If that pipe's gap
// sits low on screen, the bird would need to fly low to clear the pipe but
// high to clear the lava — an unbeatable combination. Capping how low a
// mountain-biome gap can go keeps it always above lava's max reach, so a
// valid path always exists. Once pillars can appear (the taller hazard), we
// switch to the stricter, pillar-aware bound.
const MOUNTAIN_MAX_GAP_BOTTOM_FOUNTAIN = H - 20 - LAVA_MAX_HEIGHT - LAVA_SAFE_MARGIN;
const MOUNTAIN_MAX_GAP_BOTTOM_PILLAR = H - 20 - PILLAR_MAX_HEIGHT - LAVA_SAFE_MARGIN;

function lavaHeightAt(age, type = "fountain") {
  const life = type === "pillar" ? PILLAR_LIFE : LAVA_LIFE;
  const maxHeight = type === "pillar" ? PILLAR_MAX_HEIGHT : LAVA_MAX_HEIGHT;
  if (age < 0 || age > life) return 0;
  return Math.sin((age / life) * Math.PI) * maxHeight;
}

// ---- Scoring & progressive difficulty ----
const BASE_POINT = 1;
const BIOME_POINT_MULT = { sky: 1, garden: 1.3, mountain: 1.8 };
const NEAR_MISS_MARGIN = 16; // px of clearance from a gap edge that counts as a "close call"
const NEAR_MISS_BASE_BONUS = 2;
const NEAR_MISS_STREAK_BONUS = 1; // extra point per consecutive close call, capped below
const NEAR_MISS_STREAK_CAP = 8;
const POWERUP_BONUS = 5;
const DISTANCE_SCALE = 8; // px of world-scroll per 1 "m" of displayed distance

const DIFFICULTY_RAMP_INTERVAL = 6; // every N pipes, difficulty ticks up a notch
const MAX_DIFFICULTY_TIER = 12; // hard cap so it never becomes unfair
const MIN_GAP = 118;
const GAP_SHRINK_PER_TIER = 4;
const MAX_PIPE_SPEED = 4.6;
const SPEED_GAIN_PER_TIER = 0.16;
const MIN_PIPE_INTERVAL = 145;
const INTERVAL_SHRINK_PER_TIER = 5;
const SCORE_MULT_PER_TIER = 0.12; // difficulty reward: higher tiers pay out more per pipe
const SCORE_MULT_CAP = 2.6;

function difficultyTier(obstacleCount) {
  return Math.min(MAX_DIFFICULTY_TIER, Math.floor(obstacleCount / DIFFICULTY_RAMP_INTERVAL));
}
function currentGap(obstacleCount) {
  return Math.max(MIN_GAP, GAP - difficultyTier(obstacleCount) * GAP_SHRINK_PER_TIER);
}
function currentPipeSpeed(obstacleCount) {
  return Math.min(MAX_PIPE_SPEED, PIPE_SPEED + difficultyTier(obstacleCount) * SPEED_GAIN_PER_TIER);
}
function currentPipeInterval(obstacleCount) {
  return Math.max(MIN_PIPE_INTERVAL, PIPE_INTERVAL - difficultyTier(obstacleCount) * INTERVAL_SHRINK_PER_TIER);
}
function difficultyScoreMult(obstacleCount) {
  return 1 + Math.min(SCORE_MULT_CAP - 1, difficultyTier(obstacleCount) * SCORE_MULT_PER_TIER);
}

// ---- Weather effects tied to difficulty tier ----
const WEATHER_TIER_WIND = 2;
const WEATHER_TIER_RAIN = 5;
const WEATHER_TIER_STORM = 10;

function weatherForTier(tier) {
  if (tier >= WEATHER_TIER_STORM) return "storm";
  if (tier >= WEATHER_TIER_RAIN) return "rain";
  if (tier >= WEATHER_TIER_WIND) return "wind";
  return "clear";
}
const WEATHER_HAS_WIND = { wind: true, storm: true };
const WEATHER_HAS_RAIN = { rain: true, storm: true };

const WIND_BASE_FREQ = 0.014;
const WIND_GUST_FREQ = 0.045;
const WIND_STRENGTH = 0.045; // added to bird velocity per frame at peak gust (subtle nudge, not a fight)
function windForce(frame) {
  return (Math.sin(frame * WIND_BASE_FREQ) * 0.6 + Math.sin(frame * WIND_GUST_FREQ * 1.7 + 1) * 0.4) * WIND_STRENGTH;
}

const RAIN_GRAVITY_MULT = 1.08; // rain makes the bird feel only slightly heavier
const RAIN_SPAWN_CHANCE = 0.85; // per-frame chance to spawn a raindrop
const RAIN_FALL_SPEED = 9;
const RAIN_DRIFT = 2.2;

const BIRD_V_MAX = 13; // safety clamp so stacked forces (gravity+wind+rain) can never spiral out of recoverable range

export default function FlappyBird() {
  const [phase, setPhase] = useState("select");
  const [character, setCharacter] = useState("bird");
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [shieldLeft, setShieldLeft] = useState(0);
  const [headstartLeft, setHeadstartLeft] = useState(0);
  const [muted, setMuted] = useState(false);
  const [combo, setCombo] = useState(0);
  const [distance, setDistance] = useState(0);
  const [bestDistance, setBestDistance] = useState(0);
  const [lastGain, setLastGain] = useState(null); // {amount, kind} for a brief toast
  const [weather, setWeather] = useState("clear");
  const [warning, setWarning] = useState(null);
  const [runCoins, setRunCoins] = useState(0);
  const [totalCoins, setTotalCoins] = useState(0); // persistent wallet balance (spent in the shop)
  const [bonusCoins, setBonusCoins] = useState(0); // score÷2 bonus awarded at the end of a run

  const stateRef = useRef(null);
  const rafRef = useRef(null);
  const dyingRafRef = useRef(null);
  const canvasRef = useRef(null);
  const previewRefs = useRef({});
  const audioCtxRef = useRef(null);
  const masterGainRef = useRef(null);
  const musicRef = useRef({ timeoutId: null, charId: null });
  const mutedRef = useRef(false);
  const headstartAudioRef = useRef(null);
  const pendingScoreRef = useRef(0);
  const pendingDistanceRef = useRef(0);
  const [walletLoaded, setWalletLoaded] = useState(false); // guards against overwriting saved coins before load finishes

  useEffect(() => {
    mutedRef.current = muted;
    if (masterGainRef.current) {
      masterGainRef.current.gain.value = muted ? 0 : 1;
    }
  }, [muted]);

  // Load the saved coin wallet once on mount
  useEffect(() => {
    (async () => {
      try {
        const result = await window.storage.get("flappy-wallet");
        if (result && result.value) {
          const parsed = JSON.parse(result.value);
          if (typeof parsed.totalCoins === "number" && Number.isFinite(parsed.totalCoins)) {
            setTotalCoins(parsed.totalCoins);
          }
        }
      } catch (err) {
        // No saved wallet yet (first ever play) - that's fine, stay at 0.
      } finally {
        setWalletLoaded(true);
      }
    })();
  }, []);

  // Save the wallet any time it changes, once the initial load has completed
  useEffect(() => {
    if (!walletLoaded) return;
    (async () => {
      try {
        await window.storage.set("flappy-wallet", JSON.stringify({ totalCoins }));
      } catch (err) {
        console.error("Failed to save coin wallet:", err);
      }
    })();
  }, [totalCoins, walletLoaded]);

  const getAudioCtx = useCallback(() => {
    try {
      if (!audioCtxRef.current) {
        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = new AC();
        const gain = ctx.createGain();
        gain.gain.value = mutedRef.current ? 0 : 1;
        gain.connect(ctx.destination);
        audioCtxRef.current = ctx;
        masterGainRef.current = gain;
      }
      if (audioCtxRef.current.state === "suspended") {
        audioCtxRef.current.resume();
      }
      return audioCtxRef.current;
    } catch (e) {
      return null;
    }
  }, []);

  const stopMusic = useCallback(() => {
    if (musicRef.current.timeoutId) clearTimeout(musicRef.current.timeoutId);
    musicRef.current = { timeoutId: null, charId: null };
  }, []);

  const startMusic = useCallback(
    (charId) => {
      const ctx = getAudioCtx();
      if (!ctx) return;
      stopMusic();
      const theme = MUSIC_THEMES[charId] || MUSIC_THEMES.bird;
      musicRef.current.charId = charId;
      let i = 0;
      const scheduleNext = () => {
        if (musicRef.current.charId !== charId) return;
        try {
          const semis = theme.pattern[i % theme.pattern.length];
          const freq = theme.root * Math.pow(2, semis / 12);
          const t = ctx.currentTime;
          const osc = ctx.createOscillator();
          osc.type = theme.wave;
          osc.frequency.setValueAtTime(freq, t);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.06, t + 0.15);
          g.gain.exponentialRampToValueAtTime(0.0001, t + (theme.stepMs / 1000) * 0.9);
          osc.connect(g).connect(masterGainRef.current);
          osc.start(t);
          osc.stop(t + theme.stepMs / 1000);
        } catch (e) {
          // ignore scheduling errors
        }
        i++;
        musicRef.current.timeoutId = setTimeout(scheduleNext, theme.stepMs);
      };
      scheduleNext();
    },
    [getAudioCtx, stopMusic]
  );

  const ensureMusic = useCallback(
    (charId) => {
      if (mutedRef.current) return;
      if (musicRef.current.charId === charId) return;
      startMusic(charId);
    },
    [startMusic]
  );

  const playTap = useCallback(() => {
    if (mutedRef.current) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(620, t);
      osc.frequency.exponentialRampToValueAtTime(780, t + 0.08);
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(1600, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      osc.connect(filter).connect(g).connect(masterGainRef.current);
      osc.start(t);
      osc.stop(t + 0.15);
    } catch (e) {
      // ignore
    }
  }, [getAudioCtx]);

  const stopHeadstartSound = useCallback(() => {
    const h = headstartAudioRef.current;
    if (!h) return;
    try {
      const ctx = audioCtxRef.current;
      const t = ctx ? ctx.currentTime : 0;
      h.gain.gain.cancelScheduledValues(t);
      h.gain.gain.setValueAtTime(h.gain.gain.value, t);
      h.gain.gain.linearRampToValueAtTime(0.0001, t + 0.18);
      h.noise.stop(t + 0.2);
    } catch (e) {
      // ignore
    }
    clearInterval(h.crackleInterval);
    headstartAudioRef.current = null;
  }, []);

  const startHeadstartSound = useCallback(
    (durationSec) => {
      if (mutedRef.current) return;
      const ctx = getAudioCtx();
      if (!ctx) return;
      stopHeadstartSound();
      try {
        const t0 = ctx.currentTime;

        // Sustained filtered-noise "whoosh" — like fire streaming past at speed
        const bufferSize = ctx.sampleRate * 2;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        noise.loop = true;

        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.Q.value = 0.7;
        filter.frequency.setValueAtTime(1000, t0);
        filter.frequency.exponentialRampToValueAtTime(420, t0 + durationSec);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.linearRampToValueAtTime(0.16, t0 + 0.12);
        gain.gain.setValueAtTime(0.16, t0 + Math.max(0.12, durationSec - 0.3));
        gain.gain.linearRampToValueAtTime(0.0001, t0 + durationSec);

        noise.connect(filter).connect(gain).connect(masterGainRef.current);
        noise.start(t0);

        // Periodic crackle bursts for a "fire on your tail" texture
        const crackleInterval = setInterval(() => {
          try {
            const t = ctx.currentTime;
            const burst = ctx.createOscillator();
            burst.type = "square";
            burst.frequency.setValueAtTime(110 + Math.random() * 200, t);
            const bg = ctx.createGain();
            bg.gain.setValueAtTime(0.0001, t);
            bg.gain.exponentialRampToValueAtTime(0.045, t + 0.01);
            bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
            burst.connect(bg).connect(masterGainRef.current);
            burst.start(t);
            burst.stop(t + 0.06);
          } catch (e) {
            // ignore
          }
        }, 100);

        headstartAudioRef.current = { noise, filter, gain, crackleInterval };
      } catch (e) {
        // ignore
      }
    },
    [getAudioCtx, stopHeadstartSound]
  );

  const playCrashAndGameOver = useCallback(() => {
    if (mutedRef.current) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      const t0 = ctx.currentTime;

      const thudOsc = ctx.createOscillator();
      thudOsc.type = "sine";
      thudOsc.frequency.setValueAtTime(180, t0);
      thudOsc.frequency.exponentialRampToValueAtTime(40, t0 + 0.4);
      const thudGain = ctx.createGain();
      thudGain.gain.setValueAtTime(0.3, t0);
      thudGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45);
      thudOsc.connect(thudGain).connect(masterGainRef.current);
      thudOsc.start(t0);
      thudOsc.stop(t0 + 0.5);

      const bufferSize = Math.floor(ctx.sampleRate * 0.2);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.15;
      noise.connect(noiseGain).connect(masterGainRef.current);
      noise.start(t0);

      const notes = [523.25, 392.0, 329.63, 261.63];
      notes.forEach((freq, idx) => {
        const t = t0 + 0.3 + idx * 0.18;
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, t);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        osc.connect(g).connect(masterGainRef.current);
        osc.start(t);
        osc.stop(t + 0.32);
      });
    } catch (e) {
      // ignore
    }
  }, [getAudioCtx]);

  useEffect(() => {
    if (muted || phase === "select" || phase === "dead" || phase === "dying") {
      stopMusic();
      stopHeadstartSound();
      return;
    }
    ensureMusic(character);
  }, [phase, character, muted, ensureMusic, stopMusic, stopHeadstartSound]);

  useEffect(() => {
    return () => {
      stopMusic();
      stopHeadstartSound();
      if (audioCtxRef.current) {
        try {
          audioCtxRef.current.close();
        } catch (e) {
          // ignore
        }
      }
    };
  }, [stopMusic]);

  const initState = () => ({
    birdY: H / 2,
    birdV: 0,
    pipes: [],
    hazards: [],
    powerUps: [],
    coins: [],
    nextGoldenCoinAt: GOLDEN_COIN_EVERY_MIN + Math.floor(Math.random() * (GOLDEN_COIN_EVERY_MAX - GOLDEN_COIN_EVERY_MIN)),
    runCoins: 0,
    nextCoinWaveScore: WAVE_SCORE_INTERVAL,
    pendingCoinWave: false,
    obstacleCount: 0,
    biomeLast: "sky",
    biomeFrom: "sky",
    biomeSwitchFrame: -9999,
    nextPipeFrame: PIPE_INTERVAL,
    nextLavaFrame: LAVA_INTERVAL,
    nextPillarFrame: PILLAR_INTERVAL_MIN + Math.floor(Math.random() * (PILLAR_INTERVAL_MAX - PILLAR_INTERVAL_MIN)),
    nextPowerUpFrame: POWERUP_INTERVAL_MIN + Math.floor(Math.random() * (POWERUP_INTERVAL_MAX - POWERUP_INTERVAL_MIN)),
    invincible: 0,
    headstart: 0,
    headstartPickupY: H / 2,
    headstartStartFrame: 0,
    headstartSpeedT: 1,
    trail: [],
    worldScroll: 0,
    hoverPending: false,
    hoverFrames: 0,
    dying: false,
    deathRotation: 0,
    deathFrame: 0,
    flashAlpha: 0,
    frame: 0,
    score: 0,
    comboStreak: 0,
    wingAngle: 0,
    weather: "clear",
    rainDrops: [],
    lastWarningLabel: null,
  });

  const lastJumpRef = useRef(0);

  const jump = useCallback(() => {
    const now = Date.now();
    if (now - lastJumpRef.current < 140) return;
    lastJumpRef.current = now;
    if (phase === "dying" || phase === "select") return;
    playTap();
    if (phase === "idle") {
      stateRef.current = initState();
      setShieldLeft(0);
      setHeadstartLeft(0);
      setCombo(0);
      setDistance(0);
      setLastGain(null);
      setWeather("clear");
      setWarning(null);
      setRunCoins(0);
      setBonusCoins(0);
      setPhase("playing");
    } else if (phase === "playing") {
      stateRef.current.birdV = JUMP;
      stateRef.current.hoverPending = true;
      stateRef.current.hoverFrames = 0;
    } else if (phase === "dead") {
      stateRef.current = initState();
      setScore(0);
      setShieldLeft(0);
      setHeadstartLeft(0);
      setCombo(0);
      setDistance(0);
      setLastGain(null);
      setWeather("clear");
      setWarning(null);
      setRunCoins(0);
      setBonusCoins(0);
      setPhase("playing");
    }
  }, [phase, playTap]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === "Space" || e.code === "ArrowUp" || e.key === "j") {
        e.preventDefault();
        jump();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump]);

  useEffect(() => {
    if (phase !== "playing") {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    const tick = () => {
      try {
        tickBody();
      } catch (err) {
        console.error("Flappy Bird game loop error:", err);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#ff5555";
        ctx.font = "13px monospace";
        ctx.textAlign = "left";
        const msg = (err && err.message) || String(err);
        msg.match(/.{1,44}/g)?.forEach((line, i) => ctx.fillText(line, 10, 30 + i * 18));
      }
    };

    const tickBody = () => {
      const s = stateRef.current;
      const phasing = s.headstart > 0;

      if (phasing) {
        // Levitate along a centered, wavy flight path — eased in on pickup AND eased out
        // before landing so there's never a sudden velocity cut.
        const elapsed = s.frame - s.headstartStartFrame;
        const enterEase = Math.min(1, elapsed / HEADSTART_EASE_FRAMES);
        const exitFade = s.headstart < HEADSTART_EXIT_EASE_FRAMES ? s.headstart / HEADSTART_EXIT_EASE_FRAMES : 1;
        const centerY = H / 2;
        const glideY = s.headstartPickupY + (centerY - s.headstartPickupY) * enterEase;
        const wave = Math.sin(elapsed * HEADSTART_WAVE_SPEED) * HEADSTART_WAVE_AMPLITUDE * enterEase * exitFade;
        s.birdV = 0;
        s.birdY = glideY + wave;
        s.headstartSpeedT = enterEase * exitFade;
      } else if (s.hoverFrames > 0) {
        s.hoverFrames--;
      } else {
        const tierNow = difficultyTier(s.obstacleCount);
        const weatherNow = weatherForTier(tierNow);
        const gravityMult = WEATHER_HAS_RAIN[weatherNow] ? RAIN_GRAVITY_MULT : 1;
        s.birdV += GRAVITY * gravityMult;
        if (WEATHER_HAS_WIND[weatherNow]) {
          s.birdV += windForce(s.frame);
        }
        s.birdV = Math.max(-BIRD_V_MAX, Math.min(BIRD_V_MAX, s.birdV));
        if (s.hoverPending && s.birdV >= 0) {
          s.hoverPending = false;
          s.hoverFrames = HOVER_FRAMES;
          s.birdV = 0;
        }
        s.birdY += s.birdV;
      }
      s.frame++;
      s.wingAngle = Math.sin(s.frame * 0.25) * 0.4;

      const baseSpeed = currentPipeSpeed(s.obstacleCount);
      const speedMult = phasing ? 1 + (HEADSTART_SPEED_MULT - 1) * (s.headstartSpeedT ?? 1) : 1;
      const speed = baseSpeed * speedMult;
      s.worldScroll += speed;
      if (s.frame % 15 === 0) setDistance(Math.floor(s.worldScroll / DISTANCE_SCALE));

      const tier = difficultyTier(s.obstacleCount);
      const weatherType = phasing ? "clear" : weatherForTier(tier);
      if (weatherType !== s.weather) {
        s.weather = weatherType;
        setWeather(weatherType);
      }

      if (phasing) {
        s.trail.push({ x: BIRD_X - BIRD_R, y: s.birdY, age: 0 });
      }
      for (const t of s.trail) {
        t.age++;
        t.x -= speed * 0.35;
      }
      s.trail = s.trail.filter((t) => t.age <= TRAIL_PARTICLE_LIFE);

      const currentBiome = biomeForObstacleIndex(s.obstacleCount);
      if (currentBiome !== s.biomeLast) {
        s.biomeFrom = s.biomeLast;
        s.biomeSwitchFrame = s.frame;
        s.biomeLast = currentBiome;
      }

      // ---- Upcoming-event warnings (telegraph before wind/rain/storm/pillar hit) ----
      let warningLabel = null;
      if (!phasing) {
        const nextTierWeather = weatherForTier(difficultyTier(s.obstacleCount + 1));
        if (nextTierWeather !== weatherType) {
          if (nextTierWeather === "wind") warningLabel = "⚠️ WIND INCOMING";
          else if (nextTierWeather === "rain") warningLabel = "⚠️ RAIN INCOMING";
          else if (nextTierWeather === "storm") warningLabel = "⚠️ STORM INCOMING";
        }
        if (currentBiome === "mountain" && tier >= PILLAR_TIER_MIN) {
          const untilPillar = s.nextPillarFrame - s.frame;
          if (untilPillar > 0 && untilPillar <= PILLAR_WARN_FRAMES) {
            warningLabel = "🌋 LAVA PILLAR INCOMING"; // most urgent — takes priority
          }
        }
      }
      if (warningLabel !== s.lastWarningLabel) {
        s.lastWarningLabel = warningLabel;
        setWarning(warningLabel);
      }

      if (!phasing && s.frame >= s.nextPipeFrame) {
        const gap = currentGap(s.obstacleCount);
        let maxBottom = H - 60;
        if (currentBiome === "mountain") {
          maxBottom = tier >= PILLAR_TIER_MIN ? MOUNTAIN_MAX_GAP_BOTTOM_PILLAR : MOUNTAIN_MAX_GAP_BOTTOM_FOUNTAIN;
        }
        const newPipe = { x: W, gapY: randomGapY(gap, maxBottom), gap, passed: false, biome: currentBiome, spawnFrame: s.frame };
        s.pipes.push(newPipe);
        s.obstacleCount++;
        s.nextPipeFrame = s.frame + currentPipeInterval(s.obstacleCount);

        // ---- Coins: spawn centered in the gap of the pipe we just placed ----
        if (s.obstacleCount >= s.nextGoldenCoinAt) {
          s.coins.push({ x: newPipe.x + PIPE_W / 2, y: newPipe.gapY + newPipe.gap / 2, golden: true, spawnFrame: s.frame });
          s.nextGoldenCoinAt =
            s.obstacleCount + GOLDEN_COIN_EVERY_MIN + Math.floor(Math.random() * (GOLDEN_COIN_EVERY_MAX - GOLDEN_COIN_EVERY_MIN));
        } else if (Math.random() < COIN_SPAWN_CHANCE) {
          s.coins.push({ x: newPipe.x + PIPE_W / 2, y: newPipe.gapY + newPipe.gap / 2, golden: false, spawnFrame: s.frame });
        }
      }

      if (!phasing && currentBiome === "mountain" && s.frame >= s.nextLavaFrame) {
        s.hazards.push({ x: W, spawnFrame: s.frame, type: "fountain" });
        s.nextLavaFrame = s.frame + LAVA_INTERVAL;
      }

      if (!phasing && currentBiome === "mountain" && tier >= PILLAR_TIER_MIN && s.frame >= s.nextPillarFrame) {
        s.hazards.push({ x: W, spawnFrame: s.frame, type: "pillar" });
        s.nextPillarFrame = s.frame + PILLAR_INTERVAL_MIN + Math.floor(Math.random() * (PILLAR_INTERVAL_MAX - PILLAR_INTERVAL_MIN));
      }

      if (s.frame >= s.nextPowerUpFrame) {
        const type = Math.random() < HEADSTART_POWERUP_CHANCE ? "headstart" : "shield";
        s.powerUps.push({ x: W, y: 60 + Math.random() * (H - 140), type, spawnFrame: s.frame });
        s.nextPowerUpFrame =
          s.frame + POWERUP_INTERVAL_MIN + Math.floor(Math.random() * (POWERUP_INTERVAL_MAX - POWERUP_INTERVAL_MIN));
      }

      // ---- Weather: rain ----
      if (WEATHER_HAS_RAIN[s.weather] && Math.random() < RAIN_SPAWN_CHANCE) {
        s.rainDrops.push({ x: Math.random() * (W + 60) - 30, y: -10, len: 10 + Math.random() * 10 });
      }
      const rainDrift = WEATHER_HAS_WIND[s.weather] ? Math.sign(windForce(s.frame)) * RAIN_DRIFT : RAIN_DRIFT * 0.4;
      for (const d of s.rainDrops) {
        d.y += RAIN_FALL_SPEED;
        d.x += rainDrift;
      }
      s.rainDrops = s.rainDrops.filter((d) => d.y < H + 20);

      for (const p of s.pipes) {
        p.x -= speed;
        if (!p.passed && p.x + PIPE_W < BIRD_X) {
          p.passed = true;

          const gapTop = p.gapY;
          const gapBottom = p.gapY + (p.gap ?? GAP);
          const clearance = Math.min(s.birdY - BIRD_R - gapTop, gapBottom - (s.birdY + BIRD_R));
          const isNearMiss = clearance >= 0 && clearance <= NEAR_MISS_MARGIN;
          s.comboStreak = isNearMiss ? s.comboStreak + 1 : 0;

          const biomeMult = BIOME_POINT_MULT[p.biome] ?? 1;
          const diffMult = difficultyScoreMult(s.obstacleCount);
          const basePoints = Math.max(1, Math.round(BASE_POINT * biomeMult * diffMult));
          const streakBonus = isNearMiss
            ? NEAR_MISS_BASE_BONUS + Math.min(NEAR_MISS_STREAK_CAP, s.comboStreak - 1) * NEAR_MISS_STREAK_BONUS
            : 0;
          const gained = basePoints + streakBonus;

          s.score += gained;
          setScore(s.score);
          setCombo(s.comboStreak);
          setLastGain({ amount: gained, kind: isNearMiss ? "combo" : "pipe", id: s.frame });
        }
      }
      s.pipes = s.pipes.filter((p) => p.x + PIPE_W > 0);

      // ---- Coin wave: every WAVE_SCORE_INTERVAL points, once no pipe is near the spawn edge ----
      if (!s.pendingCoinWave && s.score >= s.nextCoinWaveScore) {
        s.pendingCoinWave = true;
      }
      if (s.pendingCoinWave && !phasing) {
        const blocked = s.pipes.some((p) => p.x > W - WAVE_CLEAR_ZONE);
        if (!blocked) {
          for (let i = 0; i < WAVE_COIN_COUNT; i++) {
            s.coins.push({
              x: W + i * WAVE_COIN_SPACING,
              y: H / 2 + Math.sin(i * 0.9) * WAVE_AMPLITUDE,
              golden: false,
              spawnFrame: s.frame,
            });
          }
          const waveSpan = WAVE_COIN_COUNT * WAVE_COIN_SPACING + 140; // extra margin so a pipe doesn't crowd the tail coins
          const resumeFrame = s.frame + Math.ceil(waveSpan / speed);
          s.nextPipeFrame = Math.max(s.nextPipeFrame, resumeFrame);
          s.nextLavaFrame = Math.max(s.nextLavaFrame, resumeFrame);
          s.nextPillarFrame = Math.max(s.nextPillarFrame, resumeFrame);
          s.pendingCoinWave = false;
          s.nextCoinWaveScore += WAVE_SCORE_INTERVAL;
        }
      }

      for (const hz of s.hazards) hz.x -= speed;
      s.hazards = s.hazards.filter((hz) => {
        const w = hz.type === "pillar" ? PILLAR_W : LAVA_W;
        const life = hz.type === "pillar" ? PILLAR_LIFE : LAVA_LIFE;
        return hz.x + w > 0 && s.frame - hz.spawnFrame <= life;
      });

      for (const pu of s.powerUps) {
        pu.x -= speed;
      }
      s.powerUps = s.powerUps.filter((pu) => {
        if (pu.x < -POWERUP_R) return false;
        const dx = pu.x - BIRD_X;
        const dy = pu.y - s.birdY;
        if (Math.sqrt(dx * dx + dy * dy) < POWERUP_R + BIRD_R) {
          s.score += POWERUP_BONUS;
          setScore(s.score);
          setLastGain({ amount: POWERUP_BONUS, kind: "powerup", id: s.frame });
          if (pu.type === "headstart") {
            s.headstart = HEADSTART_FRAMES;
            s.headstartPickupY = s.birdY;
            s.headstartStartFrame = s.frame;
            s.headstartSpeedT = 0;
            s.birdV = 0;
            startHeadstartSound(HEADSTART_FRAMES / 60);
            // Hold off new obstacles until a moment after landing
            const resumeFrame = s.frame + HEADSTART_FRAMES + HEADSTART_LANDING_BUFFER;
            s.nextPipeFrame = Math.max(s.nextPipeFrame, resumeFrame);
            s.nextLavaFrame = Math.max(s.nextLavaFrame, resumeFrame);
          } else {
            s.invincible = INVINCIBLE_FRAMES;
          }
          return false;
        }
        return true;
      });

      if (s.invincible > 0) s.invincible--;
      if (s.frame % 15 === 0 || s.invincible === 0) {
        setShieldLeft(Math.ceil(s.invincible / 60));
      }
      if (s.headstart > 0) {
        s.headstart--;
        if (s.headstart === 0) stopHeadstartSound();
      }
      if (s.frame % 15 === 0 || s.headstart === 0) {
        setHeadstartLeft(Math.ceil(s.headstart / 60));
      }

      for (const c of s.coins) {
        c.x -= speed;
      }
      s.coins = s.coins.filter((c) => {
        if (c.x < -COIN_R) return false;
        const dx = c.x - BIRD_X;
        const dy = c.y - s.birdY;
        if (Math.sqrt(dx * dx + dy * dy) < COIN_R + BIRD_R) {
          const value = c.golden ? GOLDEN_COIN_VALUE : COIN_VALUE;
          s.runCoins = (s.runCoins || 0) + value;
          setRunCoins(s.runCoins);
          setLastGain({ amount: value, kind: c.golden ? "goldcoin" : "coin", id: s.frame });
          return false;
        }
        return true;
      });

      if (!phasing && (s.birdY + BIRD_R > H || s.birdY - BIRD_R < 0)) {
        triggerDeath(s.score);
        return;
      }

      const protectedByPower = s.invincible > 0 || phasing;

      if (!protectedByPower) {
        for (const p of s.pipes) {
          if (BIRD_X + BIRD_R > p.x + 6 && BIRD_X - BIRD_R < p.x + PIPE_W - 6) {
            if (s.birdY - BIRD_R < p.gapY || s.birdY + BIRD_R > p.gapY + (p.gap ?? GAP)) {
              triggerDeath(s.score);
              return;
            }
          }
        }
        for (const hz of s.hazards) {
          const age = s.frame - hz.spawnFrame;
          const height = lavaHeightAt(age, hz.type);
          if (height <= 2) continue;
          const w = hz.type === "pillar" ? PILLAR_W : LAVA_W;
          if (BIRD_X + BIRD_R > hz.x && BIRD_X - BIRD_R < hz.x + w) {
            if (s.birdY + BIRD_R > H - 20 - height) {
              triggerDeath(s.score);
              return;
            }
          }
        }
      }

      draw(ctx, s);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase]);

  useEffect(() => {
    if (phase !== "dying") {
      if (dyingRafRef.current) cancelAnimationFrame(dyingRafRef.current);
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    const groundY = H - 20 - BIRD_R;

    const tick = () => {
      const s = stateRef.current;

      s.birdV += DEATH_GRAVITY;
      s.birdY = Math.min(s.birdY + s.birdV, groundY);
      s.deathRotation += DEATH_SPIN_SPEED;
      s.deathFrame++;
      s.wingAngle = Math.sin((s.frame + s.deathFrame) * 0.25) * 0.4; // keep flapping through the fall instead of freezing mid-motion
      if (s.flashAlpha > 0) s.flashAlpha = Math.max(0, s.flashAlpha - 0.08);

      drawScene(ctx, s);
      drawCharacter(ctx, BIRD_X, s.birdY, s.birdV, s.wingAngle, 0, character, s.deathRotation);
      if (s.flashAlpha > 0) {
        ctx.fillStyle = `rgba(233,69,96,${s.flashAlpha})`;
        ctx.fillRect(0, 0, W, H);
      }

      const grounded = s.birdY >= groundY;
      if (grounded || s.deathFrame >= DEATH_MAX_FRAMES) {
        finalizeDeath();
        return;
      }

      dyingRafRef.current = requestAnimationFrame(tick);
    };

    dyingRafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(dyingRafRef.current);
  }, [phase, character]);

  const triggerDeath = (finalScore) => {
    playCrashAndGameOver();
    stopHeadstartSound();
    pendingScoreRef.current = finalScore;
    const s = stateRef.current;
    pendingDistanceRef.current = Math.floor(s.worldScroll / DISTANCE_SCALE);
    s.dying = true;
    s.deathRotation = 0;
    s.deathFrame = 0;
    s.flashAlpha = 0.55;
    setPhase("dying");
  };

  const finalizeDeath = () => {
    setBest((b) => Math.max(b, pendingScoreRef.current));
    setBestDistance((b) => Math.max(b, pendingDistanceRef.current));
    setDistance(pendingDistanceRef.current);
    const bonus = Math.floor(pendingScoreRef.current / 2);
    setBonusCoins(bonus);
    const collectedThisRun = stateRef.current?.runCoins || 0;
    setTotalCoins((t) => t + collectedThisRun + bonus);
    setPhase("dead");
  };

  const drawScene = (ctx, s) => {
    const dayT = (s.frame % DAY_CYCLE_FRAMES) / DAY_CYCLE_FRAMES;
    const { top, bottom, nightAmount } = getSkyColors(dayT);
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, top);
    sky.addColorStop(1, bottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    if (nightAmount > 0.02) {
      ctx.fillStyle = `rgba(255,255,255,${0.6 * nightAmount})`;
      for (let i = 0; i < 40; i++) {
        const sx = (i * 137 + 11) % W;
        const sy = (i * 97 + 7) % (H * 0.7);
        const r = i % 3 === 0 ? 1.5 : 0.8;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const currentBiome = biomeForObstacleIndex(s.obstacleCount);
    const theme = BIOME_THEME[currentBiome];
    const fromTheme = BIOME_THEME[s.biomeFrom] || theme;
    const biomeT = Math.min(1, (s.frame - s.biomeSwitchFrame) / BIOME_TRANSITION_FRAMES);

    if (biomeT < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - biomeT;
      drawBackdrop(ctx, s.biomeFrom, s.worldScroll);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = biomeT;
    drawBackdrop(ctx, currentBiome, s.worldScroll);
    ctx.restore();

    ctx.fillStyle = biomeT < 1 ? lerpColor(fromTheme.groundTop, theme.groundTop, biomeT) : theme.groundTop;
    ctx.fillRect(0, H - 20, W, 20);
    ctx.fillStyle = biomeT < 1 ? lerpColor(fromTheme.groundAccent, theme.groundAccent, biomeT) : theme.groundAccent;
    ctx.fillRect(0, H - 22, W, 3);

    if (biomeT < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - biomeT;
      drawGroundDecor(ctx, s.worldScroll, s.biomeFrom);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = biomeT;
    drawGroundDecor(ctx, s.worldScroll, currentBiome);
    ctx.restore();

    for (const hz of s.hazards) {
      if (hz.type === "pillar") drawLavaPillar(ctx, hz.x, s.frame - hz.spawnFrame);
      else drawLava(ctx, hz.x, s.frame - hz.spawnFrame);
    }

    for (const p of s.pipes) {
      const age = s.frame - (p.spawnFrame || 0);
      const pop = age >= POP_DURATION_FRAMES ? 1 : popEase(age / POP_DURATION_FRAMES);
      drawPipe(ctx, p.x, p.gapY, p.gapY + (p.gap ?? GAP), p.biome || "sky", pop);
    }

    for (const c of s.coins) {
      const age = s.frame - (c.spawnFrame || 0);
      const pop = age >= POP_DURATION_FRAMES ? 1 : popEase(age / POP_DURATION_FRAMES);
      drawCoin(ctx, c.x, c.y, s.frame, c.golden, pop);
    }

    for (const pu of s.powerUps) {
      const age = s.frame - (pu.spawnFrame || 0);
      const pop = age >= POP_DURATION_FRAMES ? 1 : popEase(age / POP_DURATION_FRAMES);
      drawPowerUp(ctx, pu.x, pu.y, s.frame, pu.type || "shield", pop);
    }
  };

  const drawBackdrop = (ctx, biome, worldScroll) => {
    if (biome === "mountain") {
      const baseAlpha = ctx.globalAlpha; // always multiply against this, never overwrite — keeps the crossfade intact

      // Ambient grey-to-fiery wash across the sky
      const wash = ctx.createLinearGradient(0, 0, 0, H - 20);
      wash.addColorStop(0, "rgba(55,53,56,0.35)");
      wash.addColorStop(0.6, "rgba(95,60,45,0.22)");
      wash.addColorStop(1, "rgba(190,75,30,0.32)");
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, W, H - 20);

      // Drifting ash/smoke wisps
      ctx.save();
      ctx.globalAlpha = baseAlpha * 0.35;
      ctx.fillStyle = "#5a5750";
      const smokeOff = worldScroll * 0.1;
      for (let i = -1; i <= Math.ceil(W / 150) + 1; i++) {
        const sx = i * 150 - (smokeOff % 150);
        const pop = edgePop(sx + 30);
        if (pop <= 0) continue;
        ctx.save();
        ctx.translate(sx, 60 + (i % 2) * 26);
        ctx.scale(pop, pop);
        ctx.beginPath();
        ctx.arc(0, 0, 14, 0, Math.PI * 2);
        ctx.arc(13, 4, 12, 0, Math.PI * 2);
        ctx.arc(-11, 5, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      // Distant charcoal peaks with a glowing magma vein down each face
      const peakSpacing = 140;
      const off = worldScroll * 0.25;
      for (let i = -1; i <= Math.ceil(W / peakSpacing) + 1; i++) {
        const px = i * peakSpacing - (off % peakSpacing);
        const pop = edgePop(px + 60);
        if (pop <= 0) continue;
        ctx.save();
        ctx.translate(px, H - 20);
        ctx.scale(pop, pop);
        ctx.fillStyle = "rgba(38,34,34,0.5)";
        ctx.beginPath();
        ctx.moveTo(-60, 0);
        ctx.lineTo(0, -90);
        ctx.lineTo(60, 0);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(255,120,40,0.55)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, -80);
        ctx.lineTo(-8, -42);
        ctx.lineTo(5, -12);
        ctx.stroke();
        ctx.restore();
      }
    } else if (biome === "garden") {
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      const off = worldScroll * 0.18;
      for (let i = -1; i <= Math.ceil(W / 190) + 1; i++) {
        const cx = i * 190 - (off % 190);
        drawCloud(ctx, cx, 46 + (i % 2) * 30, edgePop(cx + 34));
      }
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      const off = worldScroll * 0.15;
      for (let i = -1; i <= Math.ceil(W / 170) + 1; i++) {
        const cx = i * 170 - (off % 170);
        drawCloud(ctx, cx, 55 + (i % 3) * 24, edgePop(cx + 34));
      }
    }
  };

  const drawCloud = (ctx, x, y, pop = 1) => {
    if (pop <= 0) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(pop, pop);
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, Math.PI * 2);
    ctx.arc(16, 4, 18, 0, Math.PI * 2);
    ctx.arc(-16, 5, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const drawGroundDecor = (ctx, worldScroll, biome) => {
    const groundY = H - 20;
    const off = worldScroll % DECOR_SPACING;
    const baseIndex = Math.floor(worldScroll / DECOR_SPACING);
    for (let i = -1; i <= Math.ceil(W / DECOR_SPACING) + 1; i++) {
      const x = i * DECOR_SPACING - off + DECOR_SPACING / 2;
      const pop = edgePop(x + 14);
      if (pop <= 0) continue;
      const parity = (i + baseIndex) % 2 === 0;
      if (biome === "mountain") {
        const variant = ((i + baseIndex) % 3 + 3) % 3;
        if (variant === 0) drawGoat(ctx, x, groundY, pop);
        else if (variant === 1) drawObsidianRock(ctx, x, groundY, pop);
        else drawMagmaPool(ctx, x, groundY, pop);
      } else if (biome === "garden") {
        if (parity) drawFlowerClump(ctx, x, groundY, pop);
        else drawGoat(ctx, x, groundY, pop);
      }
    }
  };

  const drawObsidianRock = (ctx, x, groundY, pop = 1) => {
    ctx.save();
    ctx.translate(x, groundY);
    ctx.scale(pop, pop);
    const grad = ctx.createLinearGradient(0, -20, 0, 0);
    grad.addColorStop(0, "#3a3a3d");
    grad.addColorStop(1, "#161618");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-14, 0);
    ctx.lineTo(-10, -14);
    ctx.lineTo(-1, -19);
    ctx.lineTo(8, -12);
    ctx.lineTo(13, 0);
    ctx.closePath();
    ctx.fill();
    // glassy obsidian highlight
    ctx.strokeStyle = "rgba(150,170,190,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-8, -12);
    ctx.lineTo(-2, -17);
    ctx.stroke();
    // thin glowing seam
    ctx.strokeStyle = "rgba(255,120,40,0.5)";
    ctx.beginPath();
    ctx.moveTo(2, -14);
    ctx.lineTo(5, -2);
    ctx.stroke();
    ctx.restore();
  };

  const drawMagmaPool = (ctx, x, groundY, pop = 1) => {
    ctx.save();
    ctx.translate(x, groundY);
    ctx.scale(pop, pop);
    ctx.fillStyle = "rgba(20,18,18,0.6)";
    ctx.beginPath();
    ctx.ellipse(0, -1, 17, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    const grad = ctx.createRadialGradient(0, -1, 0, 0, -1, 13);
    grad.addColorStop(0, "#ffe08a");
    grad.addColorStop(0.5, "#ff8c1a");
    grad.addColorStop(1, "#c8430f");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, -1, 12, 3.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const drawGoat = (ctx, x, groundY, pop = 1) => {
    ctx.save();
    ctx.translate(x, groundY);
    ctx.scale(pop, pop);
    ctx.fillStyle = "#e9e3d6";
    ctx.beginPath();
    ctx.ellipse(0, -9, 10, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(11, -13, 5, 4.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c9c2b0";
    ctx.fillRect(-7, -4, 2.5, 6);
    ctx.fillRect(4, -4, 2.5, 6);
    ctx.strokeStyle = "#8a8072";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(12, -17);
    ctx.lineTo(14, -21);
    ctx.moveTo(9, -17);
    ctx.lineTo(8, -21);
    ctx.stroke();
    ctx.fillStyle = "#3a3a3a";
    ctx.beginPath();
    ctx.arc(13, -13, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const drawFlowerClump = (ctx, x, groundY, pop = 1) => {
    ctx.save();
    ctx.translate(x, groundY);
    ctx.scale(pop, pop);
    ctx.strokeStyle = "#2ecc71";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -12);
    ctx.stroke();
    const petalColors = ["#ff6b81", "#ff9ff3", "#feca57"];
    ctx.fillStyle = petalColors[Math.abs(Math.round(x)) % petalColors.length];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 4, -12 + Math.sin(a) * 4, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#f1c40f";
    ctx.beginPath();
    ctx.arc(0, -12, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const drawLava = (ctx, x, age) => {
    const height = lavaHeightAt(age, "fountain");
    if (height <= 1) return;
    const baseY = H - 20;
    const flicker = Math.sin(age * 0.6) * 4;
    const grad = ctx.createLinearGradient(0, baseY, 0, baseY - height);
    grad.addColorStop(0, "#ff5e1a");
    grad.addColorStop(0.5, "#ff8c1a");
    grad.addColorStop(1, "#ffe08a");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x + LAVA_W * 0.2, baseY - height * 0.6);
    ctx.lineTo(x + LAVA_W * 0.5, baseY - height + flicker);
    ctx.lineTo(x + LAVA_W * 0.8, baseY - height * 0.6);
    ctx.lineTo(x + LAVA_W, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.ellipse(x + LAVA_W / 2, baseY - height + flicker, 5, 8, 0, 0, Math.PI * 2);
    ctx.fill();
  };

  const drawLavaPillar = (ctx, x, age) => {
    const height = lavaHeightAt(age, "pillar");
    if (height <= 1) return;
    const baseY = H - 20;
    const w = PILLAR_W;
    const wobble = Math.sin(age * 0.35) * 3;
    const tipX = x + w * 0.5 + wobble;

    // Obsidian column body
    const bodyGrad = ctx.createLinearGradient(0, baseY, 0, baseY - height);
    bodyGrad.addColorStop(0, "#161616");
    bodyGrad.addColorStop(0.6, "#2b2b2b");
    bodyGrad.addColorStop(1, "#3f3f3f");
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x + w * 0.1, baseY - height * 0.7);
    ctx.lineTo(tipX, baseY - height);
    ctx.lineTo(x + w * 0.9, baseY - height * 0.7);
    ctx.lineTo(x + w, baseY);
    ctx.closePath();
    ctx.fill();

    // Glowing magma cracks running up the column
    ctx.save();
    ctx.strokeStyle = "#ff6a1a";
    ctx.shadowBlur = 10;
    ctx.shadowColor = "#ff8c1a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.3, baseY);
    ctx.lineTo(x + w * 0.4, baseY - height * 0.45);
    ctx.lineTo(x + w * 0.22, baseY - height * 0.6);
    ctx.moveTo(x + w * 0.68, baseY);
    ctx.lineTo(x + w * 0.6, baseY - height * 0.5);
    ctx.stroke();
    ctx.restore();

    // Fiery glowing tip
    const tipGrad = ctx.createRadialGradient(tipX, baseY - height, 0, tipX, baseY - height, 11);
    tipGrad.addColorStop(0, "#fff4cc");
    tipGrad.addColorStop(0.5, "#ff8c1a");
    tipGrad.addColorStop(1, "rgba(255,94,26,0)");
    ctx.fillStyle = tipGrad;
    ctx.beginPath();
    ctx.ellipse(tipX, baseY - height, 10, 13, 0, 0, Math.PI * 2);
    ctx.fill();
  };

  const draw = (ctx, s) => {
    drawScene(ctx, s);
    for (const t of s.trail) drawFireParticle(ctx, t);
    if (s.headstart > 0) drawSpeedLines(ctx, s.frame);
    drawCharacter(ctx, BIRD_X, s.birdY, s.birdV, s.wingAngle, s.invincible, character);
    drawWeather(ctx, s);
  };

  const drawWeather = (ctx, s) => {
    if (s.weather === "rain" || s.weather === "storm") {
      ctx.fillStyle = "rgba(40,60,90,0.12)";
      ctx.fillRect(0, 0, W, H - 20);
    }

    if (WEATHER_HAS_WIND[s.weather]) {
      const gust = windForce(s.frame);
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${0.12 + Math.min(0.15, Math.abs(gust) * 0.6)})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 6; i++) {
        const y = (i * 83 + s.frame * (2 + gust * 6)) % H;
        const len = 30 + (i % 3) * 14;
        const xEnd = (s.frame * (3 + i) + i * 53) % (W + 100) - 50;
        ctx.beginPath();
        ctx.moveTo(xEnd, y);
        ctx.lineTo(xEnd + len, y + gust * 8);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (s.rainDrops.length) {
      ctx.save();
      ctx.strokeStyle = "rgba(180,220,255,0.55)";
      ctx.lineWidth = 1.4;
      for (const d of s.rainDrops) {
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - 1.5, d.y + d.len);
        ctx.stroke();
      }
      ctx.restore();
    }
  };

  const drawFireParticle = (ctx, p) => {
    const t = p.age / TRAIL_PARTICLE_LIFE;
    const r = BIRD_R * 0.85 * (1 - t);
    if (r <= 0.6) return;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - t);
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    grad.addColorStop(0, "#fff4cc");
    grad.addColorStop(0.45, "#ff9d2f");
    grad.addColorStop(1, "rgba(233,69,96,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const drawSpeedLines = (ctx, frame) => {
    ctx.save();
    ctx.strokeStyle = "rgba(0,212,255,0.4)";
    ctx.lineWidth = 2;
    for (let i = 0; i < 7; i++) {
      const y = (i * 71 + frame * 13) % H;
      const len = 26 + (i % 3) * 18;
      const xEnd = (frame * 11 + i * 47) % (W + 80) - 40;
      ctx.beginPath();
      ctx.moveTo(xEnd, y);
      ctx.lineTo(xEnd + len, y);
      ctx.stroke();
    }
    ctx.restore();
  };

  const drawCoin = (ctx, x, y, frame, golden = false, pop = 1) => {
    const spin = Math.cos(frame * 0.1); // simulates a coin spinning on its vertical axis
    const scaleX = Math.max(0.15, Math.abs(spin));
    const bob = Math.sin(frame * 0.08) * 2;
    ctx.save();
    ctx.translate(x, y + bob);
    if (pop < 1) ctx.scale(pop, pop);
    ctx.scale(scaleX, 1);

    const r = COIN_R * (golden ? 1.15 : 1);
    ctx.shadowBlur = golden ? 16 : 10;
    ctx.shadowColor = golden ? "#fff2b0" : "#ffcc33";
    const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 1, 0, 0, r);
    if (golden) {
      grad.addColorStop(0, "#fff6d6");
      grad.addColorStop(0.55, "#ffd700");
      grad.addColorStop(1, "#c9960c");
    } else {
      grad.addColorStop(0, "#fff4c2");
      grad.addColorStop(0.55, "#ffcc33");
      grad.addColorStop(1, "#c98f0c");
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // Only draw the face-detail (inner ring / sparkle) when close to face-on,
    // otherwise it'd show through the "edge" of the spin.
    if (scaleX > 0.5) {
      ctx.strokeStyle = golden ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
      ctx.stroke();
      if (golden) {
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.5);
        ctx.lineTo(r * 0.12, -r * 0.1);
        ctx.lineTo(0, r * 0.5);
        ctx.lineTo(-r * 0.12, -r * 0.1);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  };

  const drawPowerUp = (ctx, x, y, frame, type = "shield", pop = 1) => {
    const pulse = 1 + Math.sin(frame * 0.15) * 0.15;
    ctx.save();
    ctx.translate(x, y);
    if (pop < 1) ctx.scale(pop, pop);

    if (type === "headstart") {
      const rot = frame * 0.06;
      ctx.rotate(rot);
      ctx.shadowBlur = 18;
      ctx.shadowColor = "#00d4ff";
      const outerR = POWERUP_R * pulse * 1.05;
      const grad = ctx.createRadialGradient(0, 0, 1, 0, 0, outerR);
      grad.addColorStop(0, "#e0fbff");
      grad.addColorStop(0.5, "#00d4ff");
      grad.addColorStop(1, "rgba(0,212,255,0.15)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, outerR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(0, 0, outerR * 0.65, a, a + 1.1);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    ctx.shadowBlur = 16;
    ctx.shadowColor = "#f1c40f";
    ctx.fillStyle = "#f1c40f";
    ctx.beginPath();
    const spikes = 5;
    const outerR = POWERUP_R * pulse;
    const innerR = outerR * 0.5;
    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const angle = (Math.PI / spikes) * i - Math.PI / 2;
      const px = Math.cos(angle) * r;
      const py = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  const drawPipe = (ctx, x, gapTop, gapBot, biome = "sky", pop = 1) => {
    const theme = BIOME_THEME[biome] || BIOME_THEME.sky;
    ctx.save();
    if (pop < 1) {
      const cx = x + PIPE_W / 2;
      const cy = (gapTop + gapBot) / 2;
      ctx.translate(cx, cy);
      ctx.scale(pop, pop);
      ctx.translate(-cx, -cy);
    }
    const g = ctx.createLinearGradient(x, 0, x + PIPE_W, 0);
    g.addColorStop(0, theme.pipeGrad[0]);
    g.addColorStop(0.4, theme.pipeGrad[1]);
    g.addColorStop(1, theme.pipeGrad[2]);
    ctx.fillStyle = g;

    ctx.fillRect(x, 0, PIPE_W, gapTop);
    ctx.fillRect(x, gapBot, PIPE_W, H - gapBot - 20);

    if (biome === "garden") {
      // thorny vine caps
      ctx.fillStyle = theme.cap;
      drawThornCap(ctx, x, gapTop, PIPE_W, "down");
      drawThornCap(ctx, x, gapBot, PIPE_W, "up");
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(x + 4, 0, 6, gapTop - 10);
      ctx.fillRect(x + 4, gapBot + 12, 6, H - gapBot - 12);
    } else if (biome === "mountain") {
      // jagged rocky pointed caps
      ctx.fillStyle = theme.cap;
      drawRockSpikes(ctx, x, gapTop, PIPE_W, "down");
      drawRockSpikes(ctx, x, gapBot, PIPE_W, "up");
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      ctx.fillRect(x + 4, 0, 8, gapTop);
      ctx.fillRect(x + 4, gapBot, 8, H - gapBot - 20);
    } else {
      ctx.fillStyle = theme.cap;
      ctx.fillRect(x - 4, gapTop - 18, PIPE_W + 8, 18);
      ctx.fillRect(x - 4, gapBot, PIPE_W + 8, 18);
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.fillRect(x + 4, 0, 8, gapTop);
      ctx.fillRect(x + 4, gapBot + 18, 8, H - gapBot - 18);
    }
    ctx.restore();
  };

  // Thorned cap for the garden biome: a stalk collar with small triangular thorns
  const drawThornCap = (ctx, x, edgeY, w, dir) => {
    const collarH = 14;
    const y = dir === "down" ? edgeY - collarH : edgeY;
    ctx.fillRect(x - 3, y, w + 6, collarH);
    const thornCount = 4;
    for (let i = 0; i < thornCount; i++) {
      const tx = x + 6 + i * ((w - 12) / (thornCount - 1));
      const ty = dir === "down" ? y : y + collarH;
      const tipY = dir === "down" ? ty - 9 : ty + 9;
      ctx.beginPath();
      ctx.moveTo(tx - 4, ty);
      ctx.lineTo(tx, tipY);
      ctx.lineTo(tx + 4, ty);
      ctx.closePath();
      ctx.fill();
    }
  };

  // Jagged rock cap for the mountain biome: pointed stone teeth
  const drawRockSpikes = (ctx, x, edgeY, w, dir) => {
    const spikeH = 20;
    const teeth = 5;
    ctx.beginPath();
    if (dir === "down") {
      ctx.moveTo(x - 3, edgeY);
      for (let i = 0; i <= teeth; i++) {
        const tx = x - 3 + (i * (w + 6)) / teeth;
        const ty = i % 2 === 0 ? edgeY - spikeH : edgeY - spikeH * 0.4;
        ctx.lineTo(tx, ty);
      }
      ctx.lineTo(x + w + 3, edgeY);
    } else {
      ctx.moveTo(x - 3, edgeY);
      for (let i = 0; i <= teeth; i++) {
        const tx = x - 3 + (i * (w + 6)) / teeth;
        const ty = i % 2 === 0 ? edgeY + spikeH : edgeY + spikeH * 0.4;
        ctx.lineTo(tx, ty);
      }
      ctx.lineTo(x + w + 3, edgeY);
    }
    ctx.closePath();
    ctx.fill();
  };

  const drawCharacter = (ctx, x, y, v, wingAngle, invincible, charId, spinOverride = null) => {
    if (invincible > 0) {
      ctx.save();
      ctx.translate(x, y);
      const ringPulse = 1 + Math.sin(invincible * 0.3) * 0.1;
      ctx.strokeStyle = `rgba(241,196,15,${invincible < 60 ? (invincible % 12 < 6 ? 0.9 : 0.2) : 0.8})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, (BIRD_R + 8) * ringPulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    const glow = invincible > 0 ? "#f1c40f" : null;
    switch (charId) {
      case "dragon":
        drawDragon(ctx, x, y, v, wingAngle, glow, spinOverride);
        break;
      case "serpent":
        drawSerpent(ctx, x, y, v, wingAngle, glow, spinOverride);
        break;
      case "griffin":
        drawGriffin(ctx, x, y, v, wingAngle, glow, spinOverride);
        break;
      case "unicorn":
        drawUnicorn(ctx, x, y, v, wingAngle, glow, spinOverride);
        break;
      default:
        drawBird(ctx, x, y, v, wingAngle, glow, spinOverride);
    }
  };

  const drawBird = (ctx, x, y, v, wingAngle, glow, spinOverride = null) => {
    ctx.save();
    ctx.translate(x, y);
    const tilt = spinOverride != null ? spinOverride : Math.min(Math.max(v * 0.04, -0.5), 1.0);
    ctx.rotate(tilt);

    ctx.shadowBlur = 18;
    ctx.shadowColor = glow || "#e94560";
    ctx.fillStyle = "#e94560";
    ctx.beginPath();
    ctx.ellipse(0, 0, BIRD_R, BIRD_R - 2, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = "#c0392b";
    ctx.save();
    ctx.rotate(wingAngle);
    ctx.beginPath();
    ctx.ellipse(-4, 4, 8, 5, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(6, -3, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a1a2e";
    ctx.beginPath();
    ctx.arc(7, -3, 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#f39c12";
    ctx.beginPath();
    ctx.moveTo(12, -1);
    ctx.lineTo(18, 1);
    ctx.lineTo(12, 3);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  };

  const drawDragon = (ctx, x, y, v, wingAngle, glow, spinOverride = null) => {
    ctx.save();
    ctx.translate(x, y);
    const tilt = spinOverride != null ? spinOverride : Math.min(Math.max(v * 0.04, -0.5), 1.0);
    ctx.rotate(tilt);

    // tail
    ctx.fillStyle = "#1e8449";
    ctx.beginPath();
    ctx.moveTo(-BIRD_R + 2, 3);
    ctx.lineTo(-BIRD_R - 10, 8);
    ctx.lineTo(-BIRD_R + 2, 9);
    ctx.closePath();
    ctx.fill();

    ctx.shadowBlur = 18;
    ctx.shadowColor = glow || "#27ae60";
    ctx.fillStyle = "#2ecc71";
    ctx.beginPath();
    ctx.ellipse(0, 0, BIRD_R, BIRD_R - 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // wing (membranous)
    ctx.fillStyle = "rgba(30,132,73,0.85)";
    ctx.save();
    ctx.rotate(wingAngle);
    ctx.beginPath();
    ctx.moveTo(-3, 2);
    ctx.lineTo(-16, -6);
    ctx.lineTo(-14, 6);
    ctx.lineTo(-3, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // horns
    ctx.fillStyle = "#145a32";
    ctx.beginPath();
    ctx.moveTo(2, -BIRD_R + 3);
    ctx.lineTo(5, -BIRD_R - 5);
    ctx.lineTo(7, -BIRD_R + 4);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(7, -BIRD_R + 4);
    ctx.lineTo(11, -BIRD_R - 3);
    ctx.lineTo(11, -BIRD_R + 5);
    ctx.closePath();
    ctx.fill();

    // eye
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(6, -3, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc(7, -3, 1.8, 0, Math.PI * 2);
    ctx.fill();

    // snout + fire breath hint
    ctx.fillStyle = "#27ae60";
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(19, -1);
    ctx.lineTo(19, 4);
    ctx.lineTo(11, 3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#f39c12";
    ctx.beginPath();
    ctx.moveTo(19, 0);
    ctx.lineTo(24, 1.5);
    ctx.lineTo(19, 3);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  };

  const drawSerpent = (ctx, x, y, v, wingAngle, glow, spinOverride = null) => {
    ctx.save();
    ctx.translate(x, y);
    const tilt = spinOverride != null ? spinOverride : Math.min(Math.max(v * 0.03, -0.4), 0.7);
    ctx.rotate(tilt);

    // sinuous body trailing behind
    ctx.strokeStyle = "#8e44ad";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-4, 0);
    for (let i = 1; i <= 5; i++) {
      const bx = -4 - i * 6;
      const by = Math.sin(i * 1.1 + wingAngle * 3) * 6;
      ctx.lineTo(bx, by);
    }
    ctx.stroke();

    // small feathered wings
    ctx.fillStyle = "rgba(155,89,182,0.85)";
    ctx.save();
    ctx.rotate(wingAngle);
    ctx.beginPath();
    ctx.ellipse(-2, -1, 8, 4, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // head
    ctx.shadowBlur = 18;
    ctx.shadowColor = glow || "#9b59b6";
    ctx.fillStyle = "#9b59b6";
    ctx.beginPath();
    ctx.ellipse(2, 0, BIRD_R - 3, BIRD_R - 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // frill
    ctx.fillStyle = "#f1c40f";
    ctx.beginPath();
    ctx.moveTo(-2, -BIRD_R + 6);
    ctx.lineTo(2, -BIRD_R - 2);
    ctx.lineTo(6, -BIRD_R + 6);
    ctx.closePath();
    ctx.fill();

    // eye
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(6, -2, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc(7, -2, 1.5, 0, Math.PI * 2);
    ctx.fill();

    // forked tongue
    ctx.strokeStyle = "#e74c3c";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(13, 1);
    ctx.lineTo(18, 1);
    ctx.lineTo(21, -1);
    ctx.moveTo(18, 1);
    ctx.lineTo(21, 3);
    ctx.stroke();

    ctx.restore();
  };

  const drawGriffin = (ctx, x, y, v, wingAngle, glow, spinOverride = null) => {
    ctx.save();
    ctx.translate(x, y);
    const tilt = spinOverride != null ? spinOverride : Math.min(Math.max(v * 0.04, -0.5), 1.0);
    ctx.rotate(tilt);

    // lion tail tuft
    ctx.fillStyle = "#a6690f";
    ctx.beginPath();
    ctx.arc(-BIRD_R - 6, 4, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#a6690f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-BIRD_R + 2, 4);
    ctx.lineTo(-BIRD_R - 6, 4);
    ctx.stroke();

    // body (golden)
    ctx.shadowBlur = 18;
    ctx.shadowColor = glow || "#d4a017";
    ctx.fillStyle = "#d4a017";
    ctx.beginPath();
    ctx.ellipse(0, 2, BIRD_R, BIRD_R - 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // large feathered wing
    ctx.fillStyle = "#7a4b12";
    ctx.save();
    ctx.rotate(wingAngle);
    ctx.beginPath();
    ctx.moveTo(-2, 0);
    ctx.lineTo(-18, -10);
    ctx.lineTo(-12, 2);
    ctx.lineTo(-16, 8);
    ctx.lineTo(-2, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // eagle head
    ctx.fillStyle = "#f5deb3";
    ctx.beginPath();
    ctx.ellipse(6, -6, 7, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // ear tuft
    ctx.fillStyle = "#a6690f";
    ctx.beginPath();
    ctx.moveTo(3, -11);
    ctx.lineTo(5, -16);
    ctx.lineTo(7, -11);
    ctx.closePath();
    ctx.fill();

    // eye
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc(8, -7, 1.8, 0, Math.PI * 2);
    ctx.fill();

    // beak
    ctx.fillStyle = "#e67e22";
    ctx.beginPath();
    ctx.moveTo(12, -6);
    ctx.lineTo(19, -4);
    ctx.lineTo(12, -3);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  };

  const drawUnicorn = (ctx, x, y, v, wingAngle, glow, spinOverride = null) => {
    ctx.save();
    ctx.translate(x, y);
    const tilt = spinOverride != null ? spinOverride : Math.min(Math.max(v * 0.04, -0.5), 1.0);
    ctx.rotate(tilt);

    ctx.shadowBlur = 18;
    ctx.shadowColor = glow || "#ff8fd6";
    ctx.fillStyle = "#fdf6ff";
    ctx.beginPath();
    ctx.ellipse(0, 0, BIRD_R, BIRD_R - 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // pegasus wing
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.save();
    ctx.rotate(wingAngle);
    ctx.beginPath();
    ctx.moveTo(-3, 2);
    ctx.lineTo(-17, -7);
    ctx.lineTo(-11, 1);
    ctx.lineTo(-15, 7);
    ctx.lineTo(-3, 7);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(200,180,220,0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // rainbow mane tuft
    const maneColors = ["#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1", "#c56cf0"];
    for (let i = 0; i < maneColors.length; i++) {
      ctx.fillStyle = maneColors[i];
      ctx.beginPath();
      ctx.arc(-2 + i * 1.5, -BIRD_R + 3 + i * 1.2, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // horn
    ctx.fillStyle = "#f1c40f";
    ctx.beginPath();
    ctx.moveTo(4, -BIRD_R + 3);
    ctx.lineTo(7, -BIRD_R - 9);
    ctx.lineTo(9, -BIRD_R + 4);
    ctx.closePath();
    ctx.fill();

    // eye
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc(7, -3, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(7.6, -3.6, 0.7, 0, Math.PI * 2);
    ctx.fill();

    // snout
    ctx.fillStyle = "#fdf6ff";
    ctx.beginPath();
    ctx.ellipse(11, 2, 5, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  };

  useEffect(() => {
    if (phase === "playing" || phase === "select" || phase === "dying") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#1a1a2e");
    sky.addColorStop(1, "#16213e");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#0f3460";
    ctx.fillRect(0, H - 20, W, 20);
    ctx.fillStyle = "#e94560";
    ctx.fillRect(0, H - 22, W, 3);

    drawCharacter(ctx, BIRD_X, H / 2, 0, 0, 0, character);

    ctx.fillStyle = "rgba(10,15,30,0.6)";
    ctx.fillRect(0, 0, W, H);

    if (phase === "idle") {
      ctx.fillStyle = "#e94560";
      ctx.font = "bold 42px 'Courier New', monospace";
      ctx.textAlign = "center";
      ctx.fillText("FLAPPY", W / 2, H / 2 - 40);
      ctx.fillStyle = "#fff";
      ctx.font = "18px 'Courier New', monospace";
      ctx.fillText("Press SPACE / J to start", W / 2, H / 2 + 10);
    }
    // "dead" phase now renders its dialog as an HTML overlay (see GameOverDialog below)
  }, [phase, character]);

  useEffect(() => {
    if (phase !== "select") return;
    CHARACTERS.forEach((c) => {
      const canvas = previewRefs.current[c.id];
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#16213e";
      ctx.beginPath();
      ctx.arc(40, 40, 38, 0, Math.PI * 2);
      ctx.fill();
      drawCharacter(ctx, 40, 40, 0, 0, 0, c.id);
    });
  }, [phase]);

  if (phase === "select") {
    return (
      <div style={{
        minHeight: "100vh",
        background: "#0d0d1a",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Courier New', monospace",
        padding: 20,
        position: "relative",
      }}>
        <h1 style={{ color: "#e94560", letterSpacing: 2, marginBottom: 4 }}>CHOOSE YOUR FLYER</h1>
        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, marginBottom: 24 }}>
          Tap a character to begin
        </p>
        <button
          onClick={() => setMuted((m) => !m)}
          style={{
            position: "absolute",
            top: 20,
            right: 20,
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.5)",
            cursor: "pointer",
          }}
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
        </button>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
          gap: 14,
          width: W,
        }}>
          {CHARACTERS.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setCharacter(c.id);
                setPhase("idle");
              }}
              style={{
                background: "#16213e",
                border: "2px solid #0f3460",
                borderRadius: 10,
                padding: 12,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                cursor: "pointer",
                gap: 6,
              }}
            >
              <canvas
                ref={(el) => (previewRefs.current[c.id] = el)}
                width={80}
                height={80}
                style={{ borderRadius: "50%" }}
              />
              <span style={{ color: "#fff", fontSize: 14, fontWeight: "bold" }}>{c.name}</span>
              <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 10.5, textAlign: "center" }}>
                {c.desc}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0d0d1a",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Courier New', monospace",
    }}>
      <div style={{
        width: W,
        display: "flex",
        justifyContent: "space-between",
        color: "#fff",
        fontSize: 14,
        marginBottom: 10,
        padding: "0 4px",
        letterSpacing: 1,
      }}>
        <span style={{ color: "#e94560" }}>SCORE <span style={{ color: "#fff" }}>{score}</span></span>
        {phase === "playing" && shieldLeft > 0 && (
          <span style={{ color: "#f1c40f" }}>
            SHIELD <span style={{ color: "#fff" }}>{shieldLeft}s</span>
          </span>
        )}
        {phase === "playing" && headstartLeft > 0 && (
          <span style={{ color: "#00d4ff" }}>
            PHASE <span style={{ color: "#fff" }}>{headstartLeft}s</span>
          </span>
        )}
        <span style={{ color: "#f39c12" }}>BEST <span style={{ color: "#fff" }}>{best}</span></span>
        <button
          onClick={() => setMuted((m) => !m)}
          style={{ background: "none", border: "none", color: "rgba(255,255,255,0.6)", cursor: "pointer", padding: 0 }}
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
      </div>

      <div style={{
        width: W,
        display: "flex",
        justifyContent: "space-between",
        color: "rgba(255,255,255,0.55)",
        fontSize: 11,
        marginBottom: 8,
        padding: "0 4px",
        letterSpacing: 0.5,
      }}>
        <span>🪙 <span style={{ color: "#ffcc33" }}>{runCoins}</span> <span style={{ color: "rgba(255,255,255,0.35)" }}>({totalCoins})</span></span>
        <span>DIST <span style={{ color: "#fff" }}>{distance}m</span></span>
        {phase === "playing" && combo >= 2 && (
          <span style={{ color: "#00d4ff" }}>COMBO x{combo}</span>
        )}
        <span>BEST DIST <span style={{ color: "#fff" }}>{bestDistance}m</span></span>
      </div>

      <div style={{
        width: W,
        height: 18,
        textAlign: "center",
        marginBottom: 6,
        fontSize: warning ? 12 : 11,
        fontWeight: warning ? 700 : 400,
        letterSpacing: 1,
        color: warning ? "#ffcc33" :
          weather === "wind" ? "rgba(255,255,255,0.6)" :
          weather === "rain" ? "#7ec8ff" :
          weather === "storm" ? "#ff5e9e" : "transparent",
        animation: warning ? "flappy-warning-pulse 0.6s ease-in-out infinite" : "none",
      }}>
        {phase === "playing" && (
          warning ? warning :
          weather === "wind" ? "🌬️ WINDY" :
          weather === "rain" ? "🌧️ RAIN" :
          weather === "storm" ? "⛈️ STORM" :
          "\u00A0"
        )}
      </div>

      <div style={{ position: "relative", width: W, height: H }}>
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          onPointerDown={(e) => {
            e.preventDefault();
            // Touch is handled exclusively by onTouchStart below — skip here to avoid
            // a single tap firing jump() twice (once per event type).
            if (e.pointerType === "touch") return;
            jump();
          }}
          onTouchStart={(e) => {
            e.preventDefault();
            jump();
          }}
          style={{
            display: "block",
            borderRadius: 6,
            border: "2px solid #e94560",
            cursor: "pointer",
            boxShadow: "0 0 40px rgba(233,69,96,0.3)",
            touchAction: "none",
          }}
        />

        {phase === "playing" && lastGain && (
          <div
            key={lastGain.id}
            style={{
              position: "absolute",
              left: BIRD_X + 24,
              top: 90,
              pointerEvents: "none",
              fontFamily: "'Courier New', monospace",
              fontWeight: "bold",
              fontSize: lastGain.kind === "powerup" ? 15 : lastGain.kind === "goldcoin" ? 18 : 17,
              color:
                lastGain.kind === "combo" ? "#00d4ff" :
                lastGain.kind === "powerup" ? "#f1c40f" :
                lastGain.kind === "goldcoin" ? "#ffd700" :
                lastGain.kind === "coin" ? "#ffcc33" :
                "#e94560",
              textShadow: "0 0 8px rgba(0,0,0,0.6)",
              animation: "fbFloatUp 0.7s ease-out forwards",
            }}
          >
            +{lastGain.amount}
            {lastGain.kind === "combo" ? " combo!" :
              lastGain.kind === "powerup" ? " bonus!" :
              lastGain.kind === "goldcoin" ? " 💎" :
              lastGain.kind === "coin" ? " 🪙" : ""}
          </div>
        )}

        {phase === "dead" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                pointerEvents: "auto",
                width: "82%",
                maxWidth: 300,
                background: "linear-gradient(160deg, #1c2440, #0f1424)",
                border: "2px solid #e94560",
                borderRadius: 14,
                padding: "22px 20px",
                boxShadow: "0 0 50px rgba(233,69,96,0.45), 0 20px 40px rgba(0,0,0,0.5)",
                textAlign: "center",
                animation: "fbPop 0.25s ease-out",
              }}
            >
              <div
                style={{
                  color: "#e94560",
                  fontSize: 24,
                  fontWeight: "bold",
                  letterSpacing: 2,
                  marginBottom: 14,
                }}
              >
                GAME OVER
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-around",
                  marginBottom: 18,
                }}
              >
                <div>
                  <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 10, letterSpacing: 1 }}>SCORE</div>
                  <div style={{ color: "#fff", fontSize: 22, fontWeight: "bold" }}>{score}</div>
                </div>
                <div>
                  <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 10, letterSpacing: 1 }}>BEST</div>
                  <div style={{ color: "#f39c12", fontSize: 22, fontWeight: "bold" }}>
                    {Math.max(best, score)}
                  </div>
                </div>
                <div>
                  <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 10, letterSpacing: 1 }}>DISTANCE</div>
                  <div style={{ color: "#00d4ff", fontSize: 22, fontWeight: "bold" }}>
                    {distance}m
                  </div>
                </div>
              </div>

              {score > 0 && score === best && (
                <div style={{ color: "#f1c40f", fontSize: 12, marginBottom: 14 }}>New best! 🎉</div>
              )}
              {distance > 0 && distance === bestDistance && (
                <div style={{ color: "#00d4ff", fontSize: 12, marginBottom: 14 }}>New longest flight! 🚀</div>
              )}

              <div
                style={{
                  background: "rgba(255,204,51,0.08)",
                  border: "1px solid rgba(255,204,51,0.3)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  marginBottom: 16,
                  animation: "fbPop 0.3s ease-out 0.1s backwards",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>
                  <span>🪙 Coins collected</span>
                  <span style={{ color: "#ffcc33", fontWeight: "bold" }}>{runCoins}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "rgba(255,255,255,0.6)", marginBottom: 8 }}>
                  <span>🏁 Score ÷ 2 bonus</span>
                  <span style={{ color: "#ffcc33", fontWeight: "bold" }}>+{bonusCoins}</span>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 13,
                    paddingTop: 8,
                    borderTop: "1px solid rgba(255,255,255,0.15)",
                  }}
                >
                  <span style={{ color: "rgba(255,255,255,0.75)" }}>Wallet total</span>
                  <span style={{ color: "#ffd700", fontWeight: "bold" }}>💰 {totalCoins}</span>
                </div>
              </div>

              <button
                onClick={jump}
                style={{
                  width: "100%",
                  background: "#e94560",
                  border: "none",
                  borderRadius: 8,
                  color: "#fff",
                  fontFamily: "'Courier New', monospace",
                  fontWeight: "bold",
                  fontSize: 15,
                  padding: "10px 0",
                  marginBottom: 8,
                  cursor: "pointer",
                  letterSpacing: 1,
                }}
              >
                PLAY AGAIN
              </button>
              <button
                onClick={() => setPhase("select")}
                style={{
                  width: "100%",
                  background: "none",
                  border: "1px solid rgba(255,255,255,0.25)",
                  borderRadius: 8,
                  color: "rgba(255,255,255,0.7)",
                  fontFamily: "'Courier New', monospace",
                  fontSize: 13,
                  padding: "8px 0",
                  cursor: "pointer",
                }}
              >
                Change Character
              </button>
              <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, marginTop: 10 }}>
                or press SPACE / J to retry
              </div>
            </div>
          </div>
        )}
      </div>

      <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, marginTop: 12 }}>
        SPACE · J · TAP to flap
      </p>
      {phase !== "playing" && phase !== "dead" && (
        <button
          onClick={() => setPhase("select")}
          style={{
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.35)",
            fontFamily: "'Courier New', monospace",
            fontSize: 11,
            marginTop: 8,
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          change character
        </button>
      )}
      <style>{`
        @keyframes fbPop {
          from { transform: scale(0.85); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        @keyframes fbFloatUp {
          0% { transform: translateY(0); opacity: 1; }
          100% { transform: translateY(-38px); opacity: 0; }
        }
        @keyframes flappy-warning-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
