import * as THREE from 'three';
import { createControls } from './controls.js';

const container = document.getElementById('app');
const fpsEl = document.getElementById('fps');
const killsEl = document.getElementById('kills');
const fireBtn = document.getElementById('fire');
const overlay = document.getElementById('overlay');
const overlayText = document.getElementById('overlayText');
const respawnBtn = document.getElementById('respawnBtn');
const fadeEl = document.getElementById('fade');
// shop UI elements
const shopScreen = document.getElementById('shopScreen');
const shopBtn = document.getElementById('shopBtn');
const shopSelectedLabel = document.getElementById('shopSelected');
let shopSelectedItem = null; // holds currently chosen shop item id or null
let purchasedItems = {}; // record of purchased item ids (true = owned)
let inventory = []; // simple inventory list of item ids that were replaced from hotbar (persisted)

// item stats table: defines behavior for melee/gun/other item types.
// Only a small set is defined here; others fall back to the 'default' entry.
const itemStats = {
  default: {
    type: 'melee',
    meleePower: 20,    // horizontal knockback strength
    meleeUp: 5.5,      // upward lift on melee
    meleeReach: 3.2,
    gunPower: 600,     // horizontal force applied by gun equivalents
    gunCooldownMs: 5000
  },
  sword: { type:'melee', meleePower:20, meleeUp:5.5, meleeReach:3.2 },
  plasma_blade: { type:'melee', meleePower:28, meleeUp:6.0, meleeReach:3.6 },
  stealth_sword: { type:'melee', meleePower:18, meleeUp:5.0, meleeReach:3.0, stealthSpeedMult:1.33 },
  warhammer: { type:'melee', meleePower:60, meleeUp:8.0, meleeReach:2.8 },
  gun: { type:'ranged', gunPower:600, gunCooldownMs:5000 },
  railgun: { type:'ranged', gunPower:1200, gunCooldownMs:4500 },
  sniper_rifle: { type:'ranged', gunPower:1800, gunCooldownMs:8000 },
  explosive_arrow: { type:'ranged', gunPower:900, gunCooldownMs:4000 },
  grappling_hook: { type:'utility', gunPower:0, gunCooldownMs:3500 },
  regen_elixir: { type:'potion' },
  health_potion_shop: { type:'potion' },
  energy_tonic: { type:'potion' },
  smoke_bomb: { type:'handheld' },
  flashbang: { type:'handheld' },
  grenade: { type:'grenade' }
};

// central, persistent shop cost table (can be updated at runtime)
// speed_upgrade will be multiplied after each purchase so its price increases exponentially
let SHOP_COSTS = {
  // Short Range
  'plasma_blade': 380,
  'stealth_sword': 360,
  'warhammer': 4000,
  // Long Range
  'sniper_rifle': 650,
  'explosive_arrow': 500,
  'railgun': 580,
  'grappling_hook': 700,
  // Potions
  'regen_elixir': 90,
  'health_potion_shop': 60,
  'energy_tonic': 45,
  // Handhelds
  'smoke_bomb': 50,
  'flashbang': 70,
  // Legacy / misc
  'speed_boots': 75,
  'tele_shot': 200,
  // Permanent stackable upgrades
  'speed_upgrade': 50,
  'jump_upgrade': 50,
  // Cooldown upgrade (reduces cooldowns by 0.25s per purchase; multiplies price x4 each buy)
  'cooldown_upgrade': 200,
  // Extra slot purchase
  'extra_slot': 5000
};

// helper to get stats for the currently active hotbar slot
function getActiveItemStats(){
  const sel = document.querySelector(`.hotbar-slot[data-slot="${activeHotbarSlot}"]`);
  const id = sel && sel.dataset ? (sel.dataset.item || '') : '';
  // Do NOT treat empty slot 2 as a default gun; empty slots fall back to default stats
  return itemStats[id] || itemStats.default;
}

// apply weapon-specific overrides that should completely replace other upgrades/attributes
// When one of the special weapons is held, this enforces the exact behavior described in the design doc:
// - railgun: infinite-range semi-auto that hits up to 2 targets, same power as normal gun but faster gunPower & cooldown tuned
// - sniper_rifle: infinite-range 5-shots then 7.5s cooldown (handled in playerGunShoot); enforce cooldown and no other upgrades
// - explosive_arrow: infinite-range AoE that hits up to 5 targets with big knockback and 11s cooldown
// - grappling_hook: infinite-range utility that teleports/pulls and knocks; 3s cooldown
// - plasma_blade / stealth_sword / warhammer: melee overrides with specified reach/power/knockback/jump/speed
function applyEquipOverrides(){
  // Reset temporary weapon-forced globals to sensible defaults before applying overrides
  timeScale = activeUpgrades.slowMo ? 0.625 : 1.0;
  jumpMultiplier = activeUpgrades.jumpBoost ? 1.5 : 1.0;
  gunCooldownMs = itemStats.gun && itemStats.gun.gunCooldownMs ? itemStats.gun.gunCooldownMs : 5000;

  const sel = document.querySelector(`.hotbar-slot[data-slot="${activeHotbarSlot}"]`);
  const id = sel && sel.dataset ? (sel.dataset.item || '') : '';

  // If slot 2 is selected (the gun/ability slot), force all melee attributes to zero and prevent melee upgrades from applying.
  // This makes holding/using slot 2 remove melee capabilities while it's active.
  if(activeHotbarSlot === 2){
    // neutralize melee capabilities temporarily
    const meleeKeys = ['sword','plasma_blade','stealth_sword','warhammer','default'];
    meleeKeys.forEach(k=>{
      if(!itemStats[k]) itemStats[k] = {};
      itemStats[k].type = 'melee';
      itemStats[k].meleePower = 0;
      itemStats[k].meleeUp = 0;
      itemStats[k].meleeReach = 0;
    });
    // also ensure upgrades that affect movement/jump don't interfere while holding slot 2
    timeScale = 1.0;
    jumpMultiplier = 1.0;
    autoFaceActive = false;
    // keep gun cooldown configured for slot-2 actions
    gunCooldownMs = itemStats.gun && itemStats.gun.gunCooldownMs ? itemStats.gun.gunCooldownMs : 5000;
    return;
  }

  // If no special item in the active slot, keep active upgrades in effect
  if(!id) return;

  // For ranged/utility weapons that require infinite range and override upgrades, enforce their rules:
  if(id === 'railgun' || id === 'sniper_rifle' || id === 'explosive_arrow' || id === 'grappling_hook' || id === 'gun'){
    timeScale = 1.0;
    jumpMultiplier = 1.0;
    autoFaceActive = false;

    if(id === 'railgun'){
      gunCooldownMs = itemStats.railgun ? itemStats.railgun.gunCooldownMs || 4500 : 4500;
    } else if(id === 'sniper_rifle'){
      gunCooldownMs = itemStats.sniper_rifle ? itemStats.sniper_rifle.gunCooldownMs || 7500 : 7500;
    } else if(id === 'explosive_arrow'){
      gunCooldownMs = itemStats.explosive_arrow ? itemStats.explosive_arrow.gunCooldownMs || 11000 : 11000;
    } else if(id === 'grappling_hook'){
      gunCooldownMs = itemStats.grappling_hook ? itemStats.grappling_hook.gunCooldownMs || 3000 : 3000;
    } else if(id === 'gun'){
      gunCooldownMs = itemStats.gun && itemStats.gun.gunCooldownMs ? itemStats.gun.gunCooldownMs : 5000;
      if(!itemStats.gun) itemStats.gun = {};
      itemStats.gun.gunPower = Math.max(itemStats.gun.gunPower || 600, 5000);
    }
    lastGunFire = lastGunFire;
    return;
  }

  // Melee weapons override movement/jump/knockback attributes when actually equipped (non-slot-2)
  if(id === 'plasma_blade' || id === 'stealth_sword' || id === 'warhammer' || id === 'sword'){
    if(id === 'plasma_blade'){
      itemStats.plasma_blade = Object.assign({}, itemStats.plasma_blade || {}, { type:'melee', meleePower:40, meleeUp:8.0, meleeReach:4.2 });
      timeScale = 1.0;
      autoFaceActive = false;
    } else if(id === 'stealth_sword'){
      itemStats.stealth_sword = Object.assign({}, itemStats.stealth_sword || {}, { type:'melee', meleePower:18, meleeUp:5.0, meleeReach:3.0, stealthSpeedMult:1.20 });
      jumpMultiplier = 1.0;
    } else if(id === 'warhammer'){
      itemStats.warhammer = Object.assign({}, itemStats.warhammer || {}, { type:'melee', meleePower:140, meleeUp:12.0, meleeReach:2.8 });
      timeScale = 1.0;
      autoFaceActive = false;
    } else if(id === 'sword'){
      itemStats.sword = Object.assign({}, itemStats.sword || {}, { type:'melee', meleePower:20, meleeUp:5.5, meleeReach:3.2 });
    }
    return;
  }
}

let scene, camera, renderer, clock, controls, hudRenderer, hudScene, hudCam, hudItems = {};
let activeHotbarSlot = 1; // current equipped hotbar slot (1..4)
let arenaRadius;
let objects = [];
let lastTime = performance.now();
let shots = [];
let killCount = 0;

// persistent state helpers (saved under "fp_state")
function loadState(){
  try {
    const raw = localStorage.getItem('fp_state');
    if(!raw) return {};
    return JSON.parse(raw);
  } catch(e){
    console.warn('loadState failed', e);
    return {};
  }
}
function saveState(state){
  try {
    // load existing and merge so callers can pass partial state
    const cur = loadState() || {};
    const merged = Object.assign({}, cur, (state || {}));
    // ensure arrays are saved as arrays
    if(merged.hotbar && !Array.isArray(merged.hotbar)) merged.hotbar = Array.from(merged.hotbar);
    if(merged.inventory && !Array.isArray(merged.inventory)) merged.inventory = Array.from(merged.inventory);
    localStorage.setItem('fp_state', JSON.stringify(merged));
  } catch(e){
    console.warn('saveState failed', e);
  }
}
// apply saved hotbar and currency when available
function applySavedState(){
  const s = loadState();
  if(s.totalKills != null) totalKills = Number(s.totalKills) || 0;

  // restore purchased items map if present
  if(s.purchasedItems && typeof s.purchasedItems === 'object'){
    purchasedItems = Object.assign({}, s.purchasedItems);
  }

  // If the saved state indicates an extra slot was purchased, ensure DOM has an extra slot before restoring hotbar values.
  if(purchasedItems && purchasedItems.extra_slot){
    ensureHotbarSlots(8);
  } else if(s.hotbar && Array.isArray(s.hotbar) && s.hotbar.length > 7){
    // if saved hotbar is longer than default, create enough slots to restore it
    ensureHotbarSlots(s.hotbar.length);
  }

  // apply saved hotbar items if present
  if(s.hotbar && Array.isArray(s.hotbar)){
    for(let i=0;i<s.hotbar.length;i++){
      const id = s.hotbar[i];
      const slot = document.querySelector(`.hotbar-slot[data-slot="${i+1}"]`);
      if(slot){
        if(id){
          slot.classList.remove('empty');
          slot.dataset.item = id;
          let main = slot.querySelector('.shop-label') || slot.querySelector('.gren-label') || null;
          if(!main){
            main = document.createElement('div');
            main.className = 'shop-label';
            main.style.fontWeight = '800';
            main.style.fontSize = '12px';
            slot.insertBefore(main, slot.querySelector('.slot-label'));
          }
          main.textContent = id.replace('_',' ');
        } else {
          slot.classList.add('empty');
          slot.dataset.item = '';
          const main = slot.querySelector('.shop-label');
          if(main) main.remove();
        }
      }
    }
  }
  // restore inventory if present
  if(s.inventory && Array.isArray(s.inventory)){
    inventory = Array.from(s.inventory);
  }
  // restore permanent upgrades if present (supports count-based stackable upgrades)
  if(s.permanentUpgrades){
    permanentUpgrades = Object.assign(permanentUpgrades, s.permanentUpgrades);
    // ensure numeric counts exist
    permanentUpgrades.speedCount = Number(permanentUpgrades.speedCount || 0);
    permanentUpgrades.jumpCount = Number(permanentUpgrades.jumpCount || 0);
    permanentUpgrades.cooldownCount = Number(permanentUpgrades.cooldownCount || 0);
    // restore cumulative cooldown reduction in ms (0.25s per purchase)
    cooldownReduction = (permanentUpgrades.cooldownCount || 0) * 250;
  }

  // disable shop buttons for already-purchased items so they cannot be bought again
  // Also add a subtle visual indicator on purchased buttons.
  setTimeout(()=>{
    const shopBtns = document.querySelectorAll('.shop-item[data-item]');
    shopBtns.forEach(btn => {
      const id = btn.dataset.item;
      if(id && purchasedItems[id]){
        btn.disabled = true;
        btn.style.opacity = '0.55';
        btn.title = (btn.title ? btn.title + ' • Owned' : 'Owned');
      }
    });
    // ensure shop currency display updates after applying saved state
    try{ updateShopKillsDisplay(); }catch(e){}
  }, 60);
}

// global time scaling (1 = normal). Multiply dt by this to implement slo-mo.
let timeScale = 1.0;

 // pending upgrades purchased in the store that will be applied for the next wave
 let pendingUpgrades = {
   slowMo: false,
   jumpBoost: false,
   autoFace: false
 };
 // active upgrades currently affecting the running wave (cleared when wave ends)
 let activeUpgrades = {
   slowMo: false,
   jumpBoost: false,
   autoFace: false
 };
 // permanent upgrades that persist across waves (jump boost should persist)
 // speedCount / jumpCount are stackable integer counters persisted to localStorage;
 // each purchase multiplies the stat by 1.2x (applied as Math.pow(1.2, count)).
 let permanentUpgrades = {
   jumpBoost: false,
   speedCount: 0,
   jumpCount: 0,
   // cooldownCount tracks how many times the cooldown-upgrade was bought; each gives -0.25s
   cooldownCount: 0
 };
 // jump multiplier applied when jump is triggered
 let jumpMultiplier = 1.0;
// when autoFace is active this flag is true for the duration of the wave
let autoFaceActive = false;
// wave / kill tracking (totalKills tracks progress across waves; waveStage is used to trigger the 15-kill notification)
let totalKills = 0;
let waveStage = 0;
let killsSinceWaveStart = 0;
let killsThisWave = 0; // track kills that occurred during the just-completed wave for stats
let highScore = 0;
let currentWaveType = 'normal'; // 'normal' or 'cannon'
let cannonActive = false;
let cannonSpeedBase = 18.0;
// Use a multiplier that accumulates separately and is applied to the base speed.
// cannonCurrentSpeedMultiplier accumulates ( *= 1.05 ), while cannonCurrentSpeed is derived from base * multiplier.
let cannonCurrentSpeedMultiplier = 1.0;
let cannonCurrentSpeed = cannonSpeedBase * cannonCurrentSpeedMultiplier;
let cannonKillsThisWave = 0;
 // support multiple simultaneous cannonballs (one per cannon-wave count)
 let cannonballs = []; // active cannonball meshes when in cannon wave
 let cannonWaveCount = 0; // how many cannon waves have occurred (used to determine spawn count)
 let cannonArrowEl = null; // UI arrow element that points to nearest cannonball

// Return the current kill threshold for finishing a wave.
// From waveStage 4 onward we require 30 kills per wave; before that keep original values:
// normal => 10, cannon => 15.
function getWaveKillThreshold(){
  return (waveStage >= 4) ? 30 : ((currentWaveType === 'normal') ? 10 : 15);
}

 // grenade tracking (thrown grenades moving toward a target)
 let grenades = []; // {mesh, startTime, duration, from, to, alive}
 // grenade inventory count (one-time consumable grenades)
 let grenadeCount = 0;
 // grenade cooldown (ms) and last throw timestamp
 let grenadeCooldownMs = 15000;
 let lastGrenadeFire = -Infinity;

 // one-use item and potion system
 // permanent reduction in cooldowns in ms applied after using Energy Tonic
 let cooldownReduction = 0;
 // timed enemy behavior flags
 let enemiesIgnoreUntil = 0; // when > now, enemies won't chase you (smoke bomb)
 let enemiesFrozenUntil = 0; // when > now, enemies won't move or attack (flashbang)
 // regen elixir state: will add 2 lives over 20s (split into two increments)
 let regenPending = false;
 let regenNextTick = 0;
 let regenTicksRemaining = 0;

 // player inter-wave UI state
 let awaitingUpgrade = false;
// when true, calls that would normally increment kill counters are suppressed
let suppressKills = false;
// centralized kill registration to honor suppressKills
function registerKill(){
  if(suppressKills) return;
  killCount += 1;
  totalKills += 1;
  killsSinceWaveStart += 1;
  if(typeof killsEl !== 'undefined' && killsEl) killsEl.textContent = `Kills: ${killCount}`;

  // always refresh shop currency display so the UI reflects the new totalKills immediately
  try {
    if(typeof updateShopKillsDisplay === 'function') updateShopKillsDisplay();
  } catch(e){
    console.warn('updateShopKillsDisplay failed', e);
  }

  // persist totalKills and current hotbar/inventory/purchased state so currency carries across reloads
  try {
    const hotbar = [];
    document.querySelectorAll('.hotbar-slot').forEach((el)=> hotbar.push(el.dataset.item || ''));
    saveState({ totalKills, hotbar, permanentUpgrades, purchasedItems, inventory });
  } catch(e){
    console.warn('saveState on registerKill failed', e);
  }
}
 // player's velocity used for smooth knockback and gravity integration
 let playerVel = new THREE.Vector3();
 // player melee cooldown & aim visuals
 const meleeCooldown = 0; // no cooldown
 let aimMarker = null;
 let playerSword = null;

 // gun cooldown (ms) and last fire timestamp
 let gunCooldownMs = 5000;
 let lastGunFire = -Infinity;

// lives & respawn
let lives = 3;
let isGameOver = false;
let invulnerableUntil = 0; // timestamp to avoid immediate repeated deaths

// falling death delay
let falling = false;
let fallStart = 0;
const fallDelay = 2000; // ms
let fadeProgress = 0;

 // pause flag to halt game updates while still rendering a frozen frame
 // Start paused so the start screen is visible until the player chooses.
 let paused = true;

// simple enemy storage
let enemies = [];
let playerOnPlatform = null; // reference to the platform mesh the player is currently standing on (if any)
 // small-platform lock state: when true the player is glued to the small orbit and cannot fall off
 let playerLockedToSmall = false;
 let smallLockOffset = new THREE.Vector3(); // camera offset relative to small platform when locked
 let originalSmallSpeed = null; // store original small orbit speed to avoid repeated reductions
 // track when the player was locked to the small platform so we can kick them off after a timeout
 let smallLockStart = 0;

init();
animate();

function init(){
  // basic scene
  scene = new THREE.Scene();

  clock = new THREE.Clock();

  // camera as player's eyes
  camera = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.1, 1000);
  // spawn much higher so player drops onto the arena
  camera.position.set(0, 18, 8);

  // renderer
  renderer = new THREE.WebGLRenderer({antialias:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.setSize(innerWidth, innerHeight);
  container.appendChild(renderer.domElement);

  // lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.9);
  hemi.position.set(0,50,0);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(-5,10,5);
  scene.add(dir);

  // arena radius (used for floor)
  arenaRadius = 30;

  // sky dome using provided allsky equirectangular texture
  const texLoader = new THREE.TextureLoader();
  const allskyTex = texLoader.load('/allsky-free-its-allsky-but-free-a-high-quality-skybox-pack-v0-9blv8ups6sy21.webp');
  allskyTex.wrapS = allskyTex.wrapT = THREE.RepeatWrapping;
  allskyTex.repeat.set(1,1);
  allskyTex.encoding = THREE.sRGBEncoding;
  scene.background = allskyTex;
  const skyDistance = 200;
  const skyGeo = new THREE.SphereGeometry(skyDistance, 48, 20);
  const skyMat = new THREE.MeshBasicMaterial({map: allskyTex, side: THREE.BackSide});
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.position.set(0, 0, 0);
  scene.add(sky);

  // floor: use provided brick-photo as tiled ground texture and extend it downward as a cylinder
  // We'll keep an invisible "hit" cylinder at the original top Y (used for collision tests)
  // and create a separate visible cylinder mesh that is shifted down for the lowered visual.
  const texLoader2 = new THREE.TextureLoader();
  const groundTex = texLoader2.load('/wall-texture-with-yellow-sand-bricks-photo.jpg');
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  groundTex.repeat.set(6,6);
  groundTex.encoding = THREE.sRGBEncoding;
  const floorMat = new THREE.MeshStandardMaterial({map: groundTex});

  // make a tall cylinder so the platform visually extends downwards into a solid column.
  const TOP_RADIUS = arenaRadius - 1;
  const CYLINDER_HEIGHT = 200; // tall enough to extend far below the arena
  const floorGeo = new THREE.CylinderGeometry(TOP_RADIUS, TOP_RADIUS, CYLINDER_HEIGHT, 64, 1, false);

  // --- hitbox cylinder (invisible) kept at the original top surface Y for physics/collisions ---
  const floorHit = new THREE.Mesh(floorGeo, new THREE.MeshBasicMaterial({visible:false}));
  // position the hitbox cylinder so its top sits at the game ground Y (4.0)
  const GROUND_Y = 4.0;
  floorHit.position.y = GROUND_Y - (CYLINDER_HEIGHT / 2);
  // record explicit top-surface metadata so collision code can treat this as the flat platform hitbox
  floorHit.userData = floorHit.userData || {};
  floorHit.userData.topY = GROUND_Y;
  floorHit.userData.topRadius = TOP_RADIUS;
  floorHit.userData.alive = true;
  scene.add(floorHit);
  // include the hitbox in the object list used by collisions
  objects.push(floorHit);

  // --- visual cylinder (visible) shifted downward so the platform appears lower than the hitbox ---
  const VISUAL_OFFSET_DOWN = 2.2; // how far visually lower the platform should appear (tweakable)
  const floorVis = new THREE.Mesh(floorGeo, floorMat);
  // move visual down but keep same horizontal footprint
  floorVis.position.y = floorHit.position.y - VISUAL_OFFSET_DOWN;
  floorVis.receiveShadow = true;
  floorVis.castShadow = false;
  // mark as visual so other systems can ignore it if needed
  floorVis.userData = floorVis.userData || {};
  floorVis.userData.visualOnly = true;
  scene.add(floorVis);

  // --- small revolving platform (both hitbox and visible) ---
  // small platform parameters
  const SMALL_TOP_RADIUS = 6.0; // top flat radius of the small platform
  const SMALL_CYL_HEIGHT = 20; // height of small cylinder geometry (deep visual column)
  const SMALL_GEO = new THREE.CylinderGeometry(SMALL_TOP_RADIUS, SMALL_TOP_RADIUS, SMALL_CYL_HEIGHT, 32, 1, false);
  const SMALL_ORBIT_RADIUS = arenaRadius + 12; // orbit closer to the arena center
  let smallPlatformAngle = Math.random() * Math.PI * 2;
  const SMALL_ORBIT_SPEED = 0.6; // radians per second

  // invisible hit cylinder for the small platform (used for collisions)
  const smallHit = new THREE.Mesh(SMALL_GEO, new THREE.MeshBasicMaterial({visible:false}));
  smallHit.position.set(Math.cos(smallPlatformAngle) * SMALL_ORBIT_RADIUS, GROUND_Y - (SMALL_CYL_HEIGHT / 2), Math.sin(smallPlatformAngle) * SMALL_ORBIT_RADIUS);
  smallHit.userData = smallHit.userData || {};
  smallHit.userData.topY = GROUND_Y;
  smallHit.userData.topRadius = SMALL_TOP_RADIUS;
  smallHit.userData.alive = true;
  smallHit.userData.isSmallOrbit = true; // marker for debugging if needed
  scene.add(smallHit);
  objects.push(smallHit);

  // visible small platform (shifted down visually like the big one)
  const smallVis = new THREE.Mesh(SMALL_GEO, floorMat.clone());
  smallVis.position.set(smallHit.position.x, smallHit.position.y - VISUAL_OFFSET_DOWN, smallHit.position.z);
  smallVis.userData = smallVis.userData || {};
  smallVis.userData.visualOnly = true;
  scene.add(smallVis);

  // store references so animate() can update the orbit
  scene.userData.smallOrbit = {
    hit: smallHit,
    vis: smallVis,
    orbitRadius: SMALL_ORBIT_RADIUS,
    angle: smallPlatformAngle,
    speed: SMALL_ORBIT_SPEED,
    topRadius: SMALL_TOP_RADIUS,
    // remember previous position so we can compute delta motion each frame
    prevPos: smallHit.position.clone()
  };

  // add a simple enemy using RickCaldwell.jpg as a face texture
  createEnemy(new THREE.Vector3(6, 1.2, -4));
  createEnemy(new THREE.Vector3(-5, 1.2, 2));

  // UI / controls - onFire will route to melee, gun, or grenade depending on equipped hotbar slot & inventory
  controls = createControls({
    camera,
    domElement: renderer.domElement,
    onFire: () => {
      // determine the currently active slot and its assigned item, then route the fire action
      const activeSlotEl = document.querySelector(`.hotbar-slot[data-slot="${activeHotbarSlot}"]`);
      const activeItemId = activeSlotEl && activeSlotEl.dataset ? (activeSlotEl.dataset.item || '') : '';

      // grenades are handled by slot 3 or by explicit 'grenade' item anywhere
      if(activeItemId === 'grenade' || activeHotbarSlot === 3){
        // only throw if slot 3 actually has grenades recorded or item is 'grenade'
        const slot3 = document.querySelector('.hotbar-slot[data-slot="3"]');
        if((activeItemId === 'grenade') || (slot3 && slot3.dataset && slot3.dataset.item === 'grenade')){
          playerThrowGrenade();
          return;
        }
      }

      // When slot 2 is selected but empty, treat it as the default gun slot (infinite-range gun).
      // Otherwise resolve stats normally.
      const stats = itemStats[activeItemId] || ((activeHotbarSlot === 2 && !activeItemId) ? itemStats.gun : itemStats.default);

      if(stats && (stats.type === 'ranged' || stats.type === 'utility' || activeHotbarSlot === 2)){
        // ensure slot-2 empty case still triggers gun behavior
        playerGunShoot();
      } else {
        playerMelee();
      }
    }
  });

  // firing button for mobile: use same routing as the main onFire handler so slot 2 works correctly on mobile
  fireBtn.addEventListener('pointerdown', (e)=>{ 
    e.preventDefault();
    const activeSlotEl = document.querySelector(`.hotbar-slot[data-slot="${activeHotbarSlot}"]`);
    const activeItemId = activeSlotEl && activeSlotEl.dataset ? (activeSlotEl.dataset.item || '') : '';

    // grenades handled by slot 3 or explicit grenade item
    if(activeItemId === 'grenade' || activeHotbarSlot === 3){
      const slot3 = document.querySelector('.hotbar-slot[data-slot="3"]');
      if((activeItemId === 'grenade') || (slot3 && slot3.dataset && slot3.dataset.item === 'grenade')){
        playerThrowGrenade();
        return;
      }
    }

    // same resolution: treat empty slot 2 as the default gun
    const stats = itemStats[activeItemId] || ((activeHotbarSlot === 2 && !activeItemId) ? itemStats.gun : itemStats.default);
    if(stats && (stats.type === 'ranged' || stats.type === 'utility' || activeHotbarSlot === 2)){
      playerGunShoot();
    } else {
      playerMelee();
    }
  });

  // create a visible sword for the player attached to the camera
  const swordGeo = new THREE.BoxGeometry(0.08,0.9,0.12);
  const swordMat = new THREE.MeshStandardMaterial({color:0xdddddd, metalness:0.9, roughness:0.3});
  playerSword = new THREE.Mesh(swordGeo, swordMat);
  // position in front-right of camera (hand)
  playerSword.position.set(0.35, -0.6, -0.8);
  playerSword.rotation.set(-0.2, 0.2, -0.6);
  // small scale to feel like a held sword
  playerSword.scale.setScalar(0.9);
  camera.add(playerSword);

  // aim marker: small red disc placed at raycast hit point so player can see aim target
  const markerGeo = new THREE.CircleGeometry(0.28, 16);
  const markerMat = new THREE.MeshBasicMaterial({color:0xff4444, side:THREE.DoubleSide, transparent:true, opacity:0.9});
  aimMarker = new THREE.Mesh(markerGeo, markerMat);
  aimMarker.rotation.x = -Math.PI/2;
  aimMarker.visible = false;
  scene.add(aimMarker);

  window.addEventListener('resize', onWindowResize);

  // --- HUD preview renderer (small overlay in bottom-right) ---
  try {
    // create a tiny Three scene to render the equipped item like a Minecraft hotbar preview
    hudScene = new THREE.Scene();
    hudCam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    hudCam.position.set(0, 0, 4);

    hudRenderer = new THREE.WebGLRenderer({antialias:true, alpha:true});
    hudRenderer.setClearColor(0x000000, 0); // transparent background
    hudRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    hudRenderer.setSize(260, 260);
    const previewWrap = document.getElementById('itemPreview');
    if(previewWrap){
      hudRenderer.domElement.style.width = '100%';
      hudRenderer.domElement.style.height = '100%';
      hudRenderer.domElement.style.borderRadius = '8px';
      hudRenderer.domElement.style.boxShadow = '0 8px 18px rgba(0,0,0,0.6)';
      previewWrap.appendChild(hudRenderer.domElement);
    }

    // small directional light for the preview
    const lh = new THREE.HemisphereLight(0xffffff, 0x222222, 0.9);
    hudScene.add(lh);
    const ld = new THREE.DirectionalLight(0xffffff, 0.6);
    ld.position.set(1,1,1);
    hudScene.add(ld);

    // helper to create a textured plane as a simple 3D prop (keeps it lightweight)
    const texLoaderHUD = new THREE.TextureLoader();
    function makeHUDItem(path, scale = 1.0){
      const tex = texLoaderHUD.load(path);
      tex.encoding = THREE.sRGBEncoding;
      // larger plane so items appear much bigger in the preview
      const geo = new THREE.PlaneGeometry(2.6 * scale, 2.6 * scale);
      // use alphaTest to discard fully transparent pixels (removes square edges)
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        transparent: true,
        side: THREE.DoubleSide,
        alphaTest: 0.05,
        depthTest: false
      });
      // ensure texture pre-multiplied alpha is handled by renderer if available
      tex.premultiplyAlpha = true;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -0.15;
      mesh.rotation.y = 0.35;
      // slightly lower so the item sits centered visually when larger
      mesh.position.set(0, -0.18, 0);
      mesh.userData.hud = true;
      mesh.visible = false;
      hudScene.add(mesh);
      return mesh;
    }

    // create the three HUD items using the project assets
    hudItems.sword = makeHUDItem('/a-sword-on-a-transparent-background-free-png.webp', 0.95);
    hudItems.gun = makeHUDItem('/plastic-water-gun-isolated-on-transparent-background-png.webp', 1.05);
    hudItems.grenade = makeHUDItem('/half-avocado-displaying-vibrant-green-flesh-and-brown-seed-on-a-clean-transparent-background-for-culinary-use-half-avocado-isolated-on-transparent-background-free-png.webp', 0.9);

    // small idle rotation for visual polish
    hudScene.userData = { time: 0 };
  } catch (err) {
    console.warn('HUD init failed', err);
  }

  // lock pointer on click for desktop
  renderer.domElement.addEventListener('click', ()=> {
    // isPointerLocked is a function now so call it to get current state
    if(!controls.isPointerLocked() && controls.enablePointerLock){
      controls.requestPointerLock();
    }
  });
}

function createEnemy(pos){
  // helper to create a small name label using canvas-to-texture
  function makeNameLabel(name, scale = 1.0){
    const canvas = document.createElement('canvas');
    const size = 256;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    // transparent background
    ctx.clearRect(0,0,size,size);
    // draw subtle pill background
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect = ctx.roundRect || function(x,y,w,h,r){ ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); };
    ctx.roundRect(32, 100, 192, 56, 12);
    ctx.fill();
    // name text
    ctx.font = 'bold 26px system-ui, Arial';
    ctx.fillStyle = '#ffd';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, size/2, 128);
    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({map: tex, transparent: true, side: THREE.DoubleSide});
    const geo = new THREE.PlaneGeometry(1.5 * scale, 0.45 * scale);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1000;
    return mesh;
  }

  // simple random-name generator (historical or comedic-sounding names)
  function randomName(){
    const names = [
      'Caesar','Cleopatra','Napoleon','Boudica','Genghis','Sappho','Plato','Ada','Tesla','Newton',
      'Beowulf','Merlin','Galileo','Hypatia','Ragnar','Attila','Homer','Aesop','Euler','Babbage',
      'TofuMax','SirSnack','CountCrunch','LadyPip','FuzzyWig','DrNoodle','BaronVonBean','Pippin','Ziggy','Mango'
    ];
    return names[Math.floor(Math.random()*names.length)];
  }

  const loader = new THREE.TextureLoader();
  const faceTex = loader.load('/RickCaldwell.jpg');
  faceTex.encoding = THREE.sRGBEncoding;
  const body = new THREE.BoxGeometry(0.9,1.6,0.5);

  // determine if this enemy is a special "red" enemy (1 out of 5)
  const isRedSpecial = (Math.random() < 0.2);
  // determine if this enemy is the rare yellow-fast (1 out of 20)
  const isYellowFast = (Math.random() < 0.05);

  // base material and possible tint for special enemies
  const matBody = new THREE.MeshStandardMaterial({
    color: isYellowFast ? 0xffdd55 : (isRedSpecial ? 0xff5555 : 0xdddddd),
    metalness: 0.1,
    roughness: 0.8
  });

  const mesh = new THREE.Mesh(body, matBody);
  // place enemy on the ground (will be affected by gravity)
  mesh.position.copy(pos);
  // ensure they start standing on the arena ground; GROUND_Y is 4.0 in animate()
  mesh.position.y = 4.0;

  // decide if this enemy is a "big" one (10% chance)
  const isBig = (Math.random() < 0.1);
  const baseScale = 1.6;
  const scaleFactor = isBig ? 2.0 : 1.0; // big ones are twice the size

  // special red enemies are 1.25x bigger than the others
  const specialSizeMultiplier = isRedSpecial ? 1.25 : 1.0;
  mesh.scale.setScalar(baseScale * scaleFactor * specialSizeMultiplier);

  // add face plane (scaled with the mesh for visual consistency)
  const faceGeo = new THREE.PlaneGeometry(0.7,0.9);
  const faceMat = new THREE.MeshStandardMaterial({map:faceTex, side: THREE.DoubleSide});
  const face = new THREE.Mesh(faceGeo, faceMat);
  face.position.set(0,0.15 * scaleFactor * specialSizeMultiplier,0.28 * scaleFactor * specialSizeMultiplier);
  // ensure the face sits slightly in front so it won't z-fight with the body box
  face.renderOrder = 999;
  mesh.add(face);

  // generate a random name and attach a small label above the torso
  const name = randomName();
  const nameLabel = makeNameLabel(name, 1.0 * (scaleFactor * specialSizeMultiplier));
  // position label slightly above the chest so it sits on the body visually
  nameLabel.position.set(0, 0.9 * (scaleFactor * specialSizeMultiplier), 0.26 * (scaleFactor * specialSizeMultiplier));
  // make it face the camera each frame by storing on userData
  nameLabel.userData.isNameLabel = true;
  mesh.add(nameLabel);

  // configure special behavior for yellow-fast enemy:
  // - faster movement (speedMult)
  // - stronger outgoing knockback (knockMultiplier)
  // - reduced incoming knockback (knockResistanceMultiplier)
  // - grants 2 grenades on death
  const givesGrenadeCount = isRedSpecial ? 1 : (isYellowFast ? 2 : 0);

  mesh.userData = {
    alive: true,
    pulse: Math.random()*10,
    vel: new THREE.Vector3(), // will include vertical (y) velocity for jumps/falls
    attackCooldown: 0,
    big: isBig,
    // big enemies do double knockback by default
    knockMultiplier: isBig ? 2 : 1,
    // special yellow-fast tweaks
    speedMult: isYellowFast ? 2.8 : 1.0,
    // yellow-fast deals stronger knockback when it hits you
    outgoingKnockMultiplier: isYellowFast ? 2.5 : 1.0,
    // reduce incoming knockback (1.0 = full knockback, <1 less effect)
    knockResistance: isYellowFast ? 0.45 : 1.0,
    // how many grenades to grant on death (0 = none)
    givesGrenadeCount: givesGrenadeCount,
    // legacy boolean kept for older checks (unchanged semantics)
    givesGrenade: givesGrenadeCount > 0,
    name: name
  };

  // visually tint or slightly change big enemies so you can tell them apart
  if(isBig){
    mesh.material.color.offsetHSL = mesh.material.color.offsetHSL || (()=>{});
    // subtle darker tint for big ones
    mesh.material.color.multiplyScalar(0.95);
  }

  scene.add(mesh);
  // store face & label reference so we can billboard them toward the camera each frame
  enemies.push({mesh, face, nameLabel});
}

function playerMelee(){
  const now = performance.now();

  // If slot 2 is currently selected, disable melee actions entirely.
  // This prevents any melee hit/knockback and ensures melee attributes are effectively removed while slot 2 is active.
  if(activeHotbarSlot === 2){
    // small visual feedback: dim sword briefly to indicate melee is disabled
    if(playerSword){
      playerSword.material.opacity = 0.35;
      playerSword.material.transparent = true;
      setTimeout(()=>{ if(playerSword){ playerSword.material.opacity = 1.0; playerSword.material.transparent = false; } }, 220);
    }
    return;
  }

  // brief visible swing feedback: tilt sword forward a bit then reset
  if(playerSword){
    playerSword.rotation.x -= 0.6;
    setTimeout(()=>{ playerSword.rotation.x += 0.6; }, 220);
  }

  // If we are in a cannon wave, sword instantly destroys any cannonball in the ray path
  if(currentWaveType === 'cannon' && cannonballs.length > 0){
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const rc = new THREE.Raycaster();
    rc.set(camera.position, forward);

    // test against all active cannonballs
    for(let i = cannonballs.length - 1; i >= 0; --i){
      const cb = cannonballs[i];
      if(!cb || !cb.userData || !cb.userData.alive) continue;
      const hits = rc.intersectObject(cb, true);
      if(hits && hits.length > 0){
        // destroy hit cannonball
        scene.remove(cb);
        cb.userData.alive = false;
        cannonballs.splice(i, 1);

        // count as a kill for cannon wave (respect suppression)
        registerKill();
        if(!suppressKills) cannonKillsThisWave += 1;

        // speed multiplier accumulates; recompute current speed from base * multiplier
        cannonCurrentSpeedMultiplier *= 1.05;
        cannonCurrentSpeed = cannonSpeedBase * cannonCurrentSpeedMultiplier;

        // spawn a replacement if the wave still expects more cannon kills
        const cannonWaveThreshold = getWaveKillThreshold();
        if(currentWaveType === 'cannon' && cannonKillsThisWave < cannonWaveThreshold){
          spawnNextCannonball(1);
        }

        // check for end of wave using centralized threshold
        const waveThreshold = getWaveKillThreshold();
        if(killsSinceWaveStart >= waveThreshold){
          handleWaveCompletion();
        }

        // melee consumed for cannonball interaction
        return;
      }
    }
    // if no cannonball hit, do nothing further (sword doesn't affect normals in cannon wave)
    return;
  }

  // For consumable potions / handhelds: if the active item is a potion or handheld, consume it on use.
  const activeSlotEl = document.querySelector(`.hotbar-slot[data-slot="${activeHotbarSlot}"]`);
  const activeItemId = activeSlotEl && activeSlotEl.dataset ? (activeSlotEl.dataset.item || '') : '';
  const stats = itemStats[activeItemId] || itemStats.default;

  // If item is a potion or handheld, trigger its effect and then remove it from hotbar/inventory.
  if(stats && (stats.type === 'potion' || stats.type === 'handheld')){
    // Smoke Bomb: enemies won't chase you for 5 seconds
    if(activeItemId === 'smoke_bomb'){
      enemiesIgnoreUntil = performance.now() + 5000;
    }
    // Flashbang: freeze/stun enemies for 5 seconds
    if(activeItemId === 'flashbang'){
      enemiesFrozenUntil = performance.now() + 5000;
    }
    // Health Potion: instantly grant 1 life
    if(activeItemId === 'health_potion_shop'){
      lives = Math.min(9999, lives + 1);
    }
    // Energy Tonic: reduce cooldowns by 1000ms for the rest of the game (cumulative)
    if(activeItemId === 'energy_tonic'){
      cooldownReduction += 1000;
      // persist reduction so reloads keep behavior if desired
      try { saveState({ totalKills, permanentUpgrades }); } catch(e){}
    }
    // Regen Elixir: give 2 lives over 20 seconds (two ticks of 10s)
    if(activeItemId === 'regen_elixir'){
      if(!regenPending){
        regenPending = true;
        regenTicksRemaining = 2;
        regenNextTick = performance.now() + 10000; // first tick after 10s
      } else {
        // if another used while pending, top up ticks
        regenTicksRemaining += 2;
      }
    }

    // Remove the used item from the hotbar and ensure it's not left in inventory duplicates.
    if(activeSlotEl){
      activeSlotEl.dataset.item = '';
      activeSlotEl.classList.add('empty');
      const main = activeSlotEl.querySelector('.shop-label');
      if(main) main.remove();
    }
    // remove one instance from inventory if it exists there
    const invIndex = inventory.indexOf(activeItemId);
    if(invIndex !== -1) inventory.splice(invIndex,1);
    try {
      const hotbar = [];
      document.querySelectorAll('.hotbar-slot').forEach((el)=> hotbar.push(el.dataset.item || ''));
      saveState({ totalKills, hotbar, permanentUpgrades, purchasedItems, inventory });
    } catch(e){}

    // feedback: small flash on the hotbar slot
    if(activeSlotEl){ activeSlotEl.style.opacity = '0.6'; setTimeout(()=>{ activeSlotEl.style.opacity = ''; }, 500); }

    return; // using a potion/handheld does not perform melee knockback
  }

  // Normal melee: short-range knockback for enemies in front of player (use horizontal checks)
  const reach = stats.meleeReach || itemStats.default.meleeReach;
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const origin = camera.position.clone();

  // project forward onto XZ for angle test
  const forwardXZ = forward.clone();
  forwardXZ.y = 0;
  forwardXZ.normalize();

  for(const e of enemies){
    const m = e.mesh;
    if(!m.userData.alive) continue;
    // use horizontal distance/angle so tall/small Y differences don't block hits
    const toEnemyXZ = new THREE.Vector3(m.position.x - origin.x, 0, m.position.z - origin.z);
    const distXZ = toEnemyXZ.length();
    if(distXZ <= reach){
      toEnemyXZ.normalize();
      const angle = forwardXZ.angleTo(toEnemyXZ);
      if(angle < Math.PI/3){
        // apply a horizontal knockback and upward lift based on item stats
        const baseKnock = stats.meleePower || itemStats.default.meleePower;
        const upLift = stats.meleeUp || itemStats.default.meleeUp;
        const stealthMult = (stats === itemStats.stealth_sword || stats.stealthSpeedMult) ? 0.9 : 1.0;
        const knock = forwardXZ.clone().multiplyScalar(baseKnock * stealthMult);
        knock.y = upLift;
        m.userData.vel.add(knock);
        // temporarily mark as "stunned" by resetting pulse
        m.userData.pulse = 0;
      }
    }
  }
}

function animate(){
  requestAnimationFrame(animate);

  // If paused, skip all updates but still render one frozen frame so user sees the paused state.
  if(paused){
    renderer.render(scene, camera);
    return;
  }

  // respect global timeScale for slow-mo; clamp raw delta first then scale
  let dt = Math.min(clock.getDelta(), 0.05);
  dt *= timeScale;

  // movement from controls
  const move = controls.getMovementVector(); // returns {x,z,lookY}

  // Apply weapon-specific overrides that forcibly set cooldowns/stats and disable conflicting upgrades.
  // This ensures holding a special weapon replaces other active attributes as requested.
  applyEquipOverrides();

  // Player base movement (modifiable by permanent speed upgrades and equipped items)
  const PLAYER_BASE_SPEED = 12;
  const playerSpeedMultiplier = Math.pow(1.2, (permanentUpgrades.speedCount || 0));
  let playerSpeed = PLAYER_BASE_SPEED * playerSpeedMultiplier;
  if(hasStealthEquipped()){
    playerSpeed *= 1.20; // 20% faster from stealth sword equip
  }

  // Enemy movement should NOT be affected by player upgrades — keep a separate constant base speed for enemies.
  const ENEMY_BASE_SPEED = 12;
  const enemySpeed = ENEMY_BASE_SPEED;

  const moveVec = new THREE.Vector3(move.x, 0, move.z).normalize().multiplyScalar(playerSpeed*dt);
  const yaw = new THREE.Euler(0, camera.rotation.y, 0, 'YXZ');
  moveVec.applyEuler(yaw);
  // prevent movement while airborne after being hit (during recent invulnerability)
  // treat ground eye-height threshold as ~4.05 (same GROUND_Y used below)
  const nowLocal = performance.now();
  const AIR_MOVE_BLOCK_Y = 4.05;
  if (!(nowLocal < invulnerableUntil && camera.position.y > AIR_MOVE_BLOCK_Y)) {
    camera.position.add(moveVec);
  }

  // integrate player velocity (horizontal + vertical) and gravity
  const GROUND_Y = 4.0; // ground height where player's eyes should rest above the sand floor

  // player jump input: only allow jump when directly contacting a platform (not while hovering)
  if(move.jump){
    let directlyOn = false;
    for(const obj of objects){
      if(!(obj.userData && obj.userData.topY !== undefined && obj.userData.topRadius !== undefined)) continue;
      const dxz = Math.hypot(camera.position.x - (obj.position.x||0), camera.position.z - (obj.position.z||0));
      const yDiff = Math.abs(camera.position.y - obj.userData.topY);
      // require horizontal overlap and very small vertical tolerance to count as direct contact
      if(dxz <= obj.userData.topRadius + 0.9 && yDiff <= 0.06){
        directlyOn = true;
        break;
      }
    }
    if(directlyOn){
      // apply jump multiplier (combine permanent / upgrade jumpMultiplier with stealth equip jump boost)
      // combine transient/permanent jump multipliers and stackable purchases (each purchase multiplies by 1.2)
      let effectiveJumpMult = (jumpMultiplier || 1.0) * Math.pow(1.2, (permanentUpgrades.jumpCount || 0));
      // stealth sword gives a modest jump boost when equipped
      const activeStats = getActiveItemStats();
      if(activeStats && activeStats === itemStats.stealth_sword){
        effectiveJumpMult *= 1.15; // ~15% extra jump when stealth sword is equipped
      }
      playerVel.y = 6.2 * effectiveJumpMult;
    }
  }

  // apply velocity to camera
  camera.position.addScaledVector(playerVel, dt);

  // gravity affects vertical velocity
  playerVel.y -= 9.8 * dt;

  // platform collision: check for any "top surface" objects (main floor + small orbiting platform)
  // choose the highest platform top under the player within its radius and snap to that Y when landing.
  let highestTopY = -Infinity;
  let onPlatform = false;
  let highestPlatform = null;
  for(const obj of objects){
    if(!(obj.userData && obj.userData.topY !== undefined && obj.userData.topRadius !== undefined)) continue;
    const dxz = Math.hypot(camera.position.x - (obj.position.x||0), camera.position.z - (obj.position.z||0));
    // only consider the top surface when the player is horizontally over the platform AND
    // the player's eye-height is within a narrow vertical band around the platform top.
    // This prevents touching the tall cylinder's side from snapping the player up.
    const verticalDiff = camera.position.y - obj.userData.topY;
    // horizontal tolerance for stepping onto edges
    const HORIZ_TOL = obj.userData.topRadius + 0.9;
    // require the player to be within ~1.2 units above the top (standing / small drop) and not far below it
    const MAX_ABOVE = 1.2;
    const MAX_BELOW = -0.5; // allow a small tolerance slightly below the top (step down)
    if(dxz <= HORIZ_TOL && verticalDiff <= MAX_ABOVE && verticalDiff >= MAX_BELOW){
      // consider this platform as a candidate
      if(obj.userData.topY > highestTopY){
        highestTopY = obj.userData.topY;
        highestPlatform = obj;
      }
    }
  }

  // Only snap to a platform top if the player is vertically close to the top surface and not clearly beside it.
  // This avoids teleporting up when merely touching the tall cylinder side.
  const VERTICAL_SNAP_TOLERANCE = 0.06; // small vertical window to consider as "on top"
  const VERTICAL_VELOCITY_ALLOWED = 0.1; // allow slight upward drift but not fast ascending
  if(highestTopY > -Infinity && camera.position.y <= highestTopY + VERTICAL_SNAP_TOLERANCE && playerVel.y <= VERTICAL_VELOCITY_ALLOWED){
    // snap player to the highest platform surface found underneath them
    camera.position.y = highestTopY;
    onPlatform = true;
    // if this platform is our small orbiting platform, mark it so movement delta keeps the player attached
    if(highestPlatform && highestPlatform.userData && highestPlatform.userData.isSmallOrbit){
      playerOnPlatform = highestPlatform;
      // If the player just got onto the small orbit platform and isn't already locked, lock them
      // Locking prevents falling off and slows the platform. Compute and store the offset so we can
      // keep the player glued to the same relative spot on the moving platform.
      if(!playerLockedToSmall){
        playerLockedToSmall = true;
        smallLockStart = performance.now();
        // compute horizontal offset from platform center to camera
        const so = scene.userData.smallOrbit;
        if(so && so.hit){
          smallLockOffset.copy(camera.position).sub(so.hit.position);
          smallLockOffset.y = 0;
          // reduce orbit speed once and remember the original value
          if(originalSmallSpeed === null){
            originalSmallSpeed = so.speed;
            so.speed = so.speed * 0.35; // slow the small platform when player is locked on
          }
        }
      } else {
        // if already locked, check for timeout and forcibly eject the player after 20s
        const LOCK_TIMEOUT_MS = 20000;
        const nowLock = performance.now();
        if(smallLockStart > 0 && nowLock - smallLockStart >= LOCK_TIMEOUT_MS){
          // unlock player from the small platform
          playerLockedToSmall = false;
          smallLockStart = 0;
          // restore small platform speed if we had stored it
          const so = scene.userData.smallOrbit;
          if(so && originalSmallSpeed !== null){
            so.speed = originalSmallSpeed;
            originalSmallSpeed = null;
          }
          // give the player a small outward nudge so they are kicked off naturally
          const outward = new THREE.Vector3().subVectors(camera.position, so.hit.position).setY(0).normalize();
          // apply a modest impulse so they land just off the platform
          playerVel.addScaledVector(outward, 8.0);
          playerVel.y = Math.max(playerVel.y, 5.0);
        }
      }
    } else {
      // standing on main floor or other static platforms — clear any platform attachment
      playerOnPlatform = null;
    }
    // stop downward velocity when hitting ground
    if(playerVel.y < 0) playerVel.y = 0;
    // slight friction on horizontal velocity when grounded
    playerVel.x *= Math.max(0, 1 - dt*6);
    playerVel.z *= Math.max(0, 1 - dt*6);
  } else {
    // when airborne or not sufficiently near the top surface, clear platform attachment so player won't be carried unexpectedly
    playerOnPlatform = null;
    // in air, mild air resistance on horizontal motion
    playerVel.x *= Math.max(0, 1 - dt*1.2);
    playerVel.z *= Math.max(0, 1 - dt*1.2);
  }

  // update enemies (gravity, movement at player speed, occasional jumps)
  // We'll collect fallen enemies to remove after iteration to avoid mutating the array mid-loop.
  const fallenEnemies = [];
  for(const e of enemies){
    const m = e.mesh;
    if(!m.userData.alive) continue;

    // apply vertical velocity (gravity & jump/fall)
    // gravity
    m.userData.vel.y -= 9.8 * dt;
    // integrate velocity into position
    m.position.addScaledVector(m.userData.vel, dt);

    // ground collision for enemies
    // Only snap enemies to the ground if they're still above the arena surface;
    // if they walk past the arena edge they should keep falling like the player.
    const enemyDistFromCenter = Math.hypot(m.position.x, m.position.z);
    const ARENA_GROUND_THRESHOLD = arenaRadius - 1.0;
    if(enemyDistFromCenter < ARENA_GROUND_THRESHOLD && m.position.y <= 4.0){
      // enemy is above arena ground: place on ground and zero downward velocity
      m.position.y = 4.0;
      if(m.userData.vel.y < 0) m.userData.vel.y = 0;
      // slight horizontal damping when grounded
      m.userData.vel.x *= Math.max(0, 1 - dt*6);
      m.userData.vel.z *= Math.max(0, 1 - dt*6);
    } else {
      // in air or beyond arena edge: let gravity act and apply air damping
      m.userData.vel.x *= Math.max(0, 1 - dt*1.2);
      m.userData.vel.z *= Math.max(0, 1 - dt*1.2);
    }

    // If enemy has fallen below the platform Y, despawn it and count it as a kill immediately
    if(m.position.y < 4.0){
      // if this enemy grants a grenade, give it now (slot 3)
      if(m.userData && (m.userData.givesGrenadeCount || m.userData.givesGrenade)){
        // increment grenade inventory by configured count and update hotbar display
        const giveCount = Number(m.userData.givesGrenadeCount || (m.userData.givesGrenade ? 1 : 0)) || 0;
        grenadeCount = (grenadeCount || 0) + giveCount;
        const slot3 = document.querySelector('.hotbar-slot[data-slot="3"]');
        if(slot3){
          slot3.classList.remove('empty');
          // update numeric display in the main label area showing grenade count
          let main = slot3.querySelector('.gren-label');
          if(!main){
            main = document.createElement('div');
            main.className = 'gren-label';
            main.style.fontWeight = '800';
            slot3.insertBefore(main, slot3.querySelector('.slot-label'));
          }
          main.textContent = `Gren x${grenadeCount}`;
          slot3.dataset.item = 'grenade';
        }
      }

      // remove from scene and mark for removal
      scene.remove(m);
      m.userData.alive = false;
      m._despawned = true;

      // count the kill immediately (one kill per enemy that falls off) but respect suppression
      registerKill();

      // check for wave completion using current wave type threshold (normal=10, cannon=15)
      const waveThreshold = getWaveKillThreshold();
      if(killsSinceWaveStart >= waveThreshold){
    handleWaveCompletion();
  }

      fallenEnemies.push(m);
      continue; // skip rest of logic for this enemy
    }

    // simple AI: move toward player on XZ plane at player's ground speed
    const toPlayer = new THREE.Vector3().subVectors(camera.position, m.position);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    // only allow ground-based navigation when the enemy is touching the ground
    const ON_GROUND_EPS = 0.01;
    // ensure enemy is considered on-ground only when vertically at ground AND within arena surface bounds
    const enemyDistFromCenterNow = Math.hypot(m.position.x, m.position.z);
    const isOnGround = (m.position.y <= 4.0 + ON_GROUND_EPS) && (enemyDistFromCenterNow < ARENA_GROUND_THRESHOLD);
    // Only pursue the player when both the enemy and the player are effectively still on the arena
    // This prevents enemies from following the player off the edge.
    const PLAYER_ARENA_LIMIT = ARENA_GROUND_THRESHOLD - 1.5; // small buffer so enemies stop a bit earlier than edge
    const playerDistFromCenter = Math.hypot(camera.position.x, camera.position.z);

    // respect flash/stun / smoke ignore timers: when frozen skip movement/attacks; when ignorable, don't chase
    const now = performance.now();
    if(dist > 1.2 && isOnGround && playerDistFromCenter < PLAYER_ARENA_LIMIT && now > enemiesFrozenUntil && now > enemiesIgnoreUntil){
      const dir = toPlayer.normalize();
      // enemies use their own base speed (not affected by player upgrades), but individual enemies can have multipliers
      const perEnemySpeed = enemySpeed * (m.userData.speedMult || 1.0);
      m.position.addScaledVector(dir, Math.min(perEnemySpeed * dt, dist));
    }

    // directed leap: if player is nearby and enemy is on the ground, occasionally leap toward the player's current position
    if(isOnGround && dist < 8.0 && Math.random() < 0.06){
      // small horizontal lunge toward player plus an upward boost
      const leapPower = 9.0;
      const upward = 5.2;
      const toward = new THREE.Vector3().subVectors(camera.position, m.position).setY(0).normalize();
      m.userData.vel.x += toward.x * leapPower;
      m.userData.vel.z += toward.z * leapPower;
      m.userData.vel.y = Math.max(m.userData.vel.y, upward);
      m.userData.pulse = 0;
    }

    // apply horizontal knockback velocity (already integrated above), decay it
    if(new THREE.Vector3(m.userData.vel.x,0,m.userData.vel.z).lengthSq() > 0.0001){
      m.userData.vel.x *= Math.max(0, 1 - dt*3);
      m.userData.vel.z *= Math.max(0, 1 - dt*3);
    }

    // occasional small random hops to add variety (but not beyond the arena)
    if(m.position.y <= 4.0 + 0.01 && (dist < 6 && Math.random() < 0.02)){
      m.userData.vel.y = 5.0;
    }

    // enemy attack if close enough (skip if player is currently falling)
    // If flashbang freeze is active skip enemy attacks too
    if(!falling && dist < 1.6 && (m.userData.attackCooldown <= 0) && performance.now() > enemiesFrozenUntil){
      // swing and apply an upward + away velocity to player for smooth knockback
      const away = new THREE.Vector3().subVectors(camera.position, m.position).setY(0).normalize();
      // use enemy's knock multiplier (big enemies do more knockback)
      const km = (m.userData.knockMultiplier) ? m.userData.knockMultiplier : 1;
      // horizontal push away and an upward boost (scaled by km)
      const horizontalPush = away.multiplyScalar(6 * km);
      playerVel.add(horizontalPush);
      // set an upward velocity so player is lifted then carried away (scaled)
      playerVel.y = Math.max(playerVel.y, 5.0 * km);
      // make player briefly invulnerable
      invulnerableUntil = performance.now() + 800;
      // longer cooldown between enemy hits to the player
      m.userData.attackCooldown = 5.0;
    }
    m.userData.attackCooldown = Math.max(0, m.userData.attackCooldown - dt);

    // breathing pulse visual (scale)
    m.userData.pulse += dt*2;
    const s = 1 + Math.sin(m.userData.pulse)*0.02;
    m.scale.setScalar(1.6 * s);

    // rotate the entire enemy to face the camera on the Y axis so the textured side is forward,
    // then ensure both the enemy and face remain upright and the face plane precisely faces the camera.
    if(e.face){
      // target at the enemy's Y so lookAt doesn't tilt the model up/down
      const target = new THREE.Vector3(camera.position.x, m.position.y, camera.position.z);
      m.lookAt(target);
      // keep the enemy perfectly upright (no pitch/roll)
      m.rotation.x = 0;
      m.rotation.z = 0;
      // also align the face plane exactly to the camera to avoid any visual offset
      e.face.lookAt(camera.position);
      e.face.rotation.x = 0;
      e.face.rotation.z = 0;
    }
  }

  // For each fallen enemy, spawn two new enemies near the arena center (kills were already counted at despawn)
  // Only spawn normal enemies when the wave type allows it and only when not awaiting upgrades.
  if(fallenEnemies.length > 0){
    if(!awaitingUpgrade && currentWaveType === 'normal'){
      for(let i=0;i<fallenEnemies.length;i++){
        // small random offsets so they don't overlap exactly
        const offset1 = new THREE.Vector3((Math.random()-0.5)*2, 0, (Math.random()-0.5)*2);
        const offset2 = new THREE.Vector3((Math.random()-0.5)*2, 0, (Math.random()-0.5)*2);
        createEnemy(new THREE.Vector3(0, 4.0, 0).add(offset1));
        createEnemy(new THREE.Vector3(0, 4.0, 0).add(offset2));
      }
    }
    // filter out despawned enemies from the main array
    enemies = enemies.filter(e => !e.mesh._despawned);
  }

  // update shots (existing projectile logic preserved)
  for(let i=shots.length-1;i>=0;i--){
    const s = shots[i];
    s.position.addScaledVector(s.userData.vel, dt);
    s.userData.life -= dt;
    for(const obj of objects){
      if(!(obj.userData && obj.userData.alive)) continue;

      // Special-case: treat tall cylinder floor as a flat top surface hitbox using recorded metadata.
      if(obj.userData.topY !== undefined && obj.userData.topRadius !== undefined){
        // horizontal distance on XZ plane from projectile to cylinder center
        const dxz = Math.hypot(s.position.x - obj.position.x, s.position.z - obj.position.z);
        // consider a collision if the shot is within reasonable vertical range of the top surface
        // and horizontally within the top radius (with small tolerance)
        if(s.position.y <= obj.userData.topY + 0.9 && dxz <= obj.userData.topRadius + 0.9){
          obj.userData.alive = false;
          obj.material = new THREE.MeshStandardMaterial({color:0x222222, metalness:0.2, roughness:1});
          scene.remove(s);
          shots.splice(i,1);
          break;
        }
        // otherwise skip this object for this projectile
        continue;
      }

      // fallback / legacy distance test for non-floor objects (sphere/box centers)
      if(s.position.distanceTo(obj.position) < 0.9){
        obj.userData.alive = false;
        obj.material = new THREE.MeshStandardMaterial({color:0x222222, metalness:0.2, roughness:1});
        scene.remove(s);
        shots.splice(i,1);
        break;
      }
    }
    if(s && s.userData && s.userData.life <= 0){
      scene.remove(s);
      shots.splice(i,1);
    }
  }

  // update thrown grenades: move them along their path and explode on contact or at end
  for(let gi = grenades.length - 1; gi >= 0; --gi){
    const g = grenades[gi];
    if(!g || !g.alive) { grenades.splice(gi,1); continue; }
    const tNow = performance.now();
    const tFrac = Math.min(1, (tNow - g.startTime) / g.duration);
    // interpolate position
    g.mesh.position.lerpVectors(g.from, g.to, tFrac);
    // check collision with enemies or objects (distance-based)
    let exploded = false;
    for(const e of enemies){
      if(!e.mesh.userData.alive) continue;
      if(g.mesh.position.distanceTo(e.mesh.position) < 1.2 + (e.mesh.scale.x * 0.5)){
        exploded = true;
        break;
      }
    }
    for(const obj of objects){
      if(g.mesh.position.distanceTo(obj.position) < 1.0){ exploded = true; break; }
    }
    if(tFrac >= 1) exploded = true;
    if(exploded){
      // explosion: find up to 3 closest enemies to the impact point and launch them SUPER far away
      const explosionPos = g.mesh.position.clone();
      if(enemies.length > 0){
        // build list of alive enemies and their distances
        const list = [];
        for(const e of enemies){
          if(!e.mesh.userData.alive) continue;
          const d = explosionPos.distanceTo(e.mesh.position);
          list.push({entry: e, dist: d});
        }
        // sort by distance and pick up to 3 closest
        list.sort((a,b)=>a.dist - b.dist);
        const toLaunch = list.slice(0,3);
        const SUPER_POWER = 2000; // extremely strong horizontal force
        for(const item of toLaunch){
          const e = item.entry;
          const toE = new THREE.Vector3().subVectors(e.mesh.position, explosionPos);
          const away = toE.setY(0).normalize();
          if(!isNaN(away.x)){
            e.mesh.userData.vel.x = away.x * SUPER_POWER;
            e.mesh.userData.vel.z = away.z * SUPER_POWER;
            // larger upward boost for dramatic launch
            e.mesh.userData.vel.y = Math.max(e.mesh.userData.vel.y, 6.0);
            e.mesh.userData.pulse = 0;
          }
        }
      }
      // remove grenade mesh
      scene.remove(g.mesh);
      g.alive = false;
      grenades.splice(gi,1);
      // show brief visual feedback on grenade slot if present
      const slot3 = document.querySelector('.hotbar-slot[data-slot="3"]');
      if(slot3){
        slot3.style.transform = 'scale(0.98)';
        setTimeout(()=>{ slot3.style.transform = ''; }, 160);
      }
    }
  }

  // Regen elixir ticking: grant scheduled lives over time
  if(regenPending && regenTicksRemaining > 0 && performance.now() >= regenNextTick){
    regenTicksRemaining -= 1;
    lives = Math.min(9999, lives + 1);
    regenNextTick = performance.now() + 10000; // next tick in 10s
    if(regenTicksRemaining <= 0){
      regenPending = false;
      regenNextTick = 0;
    }
  }

  // update cannonball when active (single flying homing target)
  if(cannonActive && cannonballs.length > 0){
    // iterate over a copy to allow removals
    for(let i = cannonballs.length - 1; i >= 0; --i){
      const cb = cannonballs[i];
      if(!cb || !cb.userData || !cb.userData.alive) {
        cannonballs.splice(i,1);
        continue;
      }
      // homing behavior: recompute direction toward player's current position and set velocity (no gravity)
      const toPlayer = new THREE.Vector3().subVectors(camera.position, cb.position);
      const d = toPlayer.length();

      if(d > 0.001){
        const dir = toPlayer.normalize();
        cb.userData.vel.copy(dir.multiplyScalar(cannonCurrentSpeed));
      }
      // integrate motion
      cb.position.addScaledVector(cb.userData.vel, dt);

      // direct contact kills player instantly
      if(d < 2.2){
        // remove the cannonball, do immediate player death
        scene.remove(cb);
        cb.userData.alive = false;
        cannonballs.splice(i,1);

        // do instant death (reason: hit by cannonball)
        playerDie('hit by cannonball');

        // spawn a replacement cannonball if wave is still active and hasn't reached its required kills
        if(currentWaveType === 'cannon'){
          spawnNextCannonball(1);
        }
        continue;
      }

      // if cannonball goes too far past arena, despawn and respawn next
      if(Math.hypot(cb.position.x, cb.position.z) > arenaRadius + 200){
        scene.remove(cb);
        cb.userData.alive = false;
        cannonballs.splice(i,1);
        if(currentWaveType === 'cannon') spawnNextCannonball(1);
        continue;
      }
    }
  }

  // update small orbiting platform (make it circle like a moon around the base)
  if(scene.userData && scene.userData.smallOrbit){
    const so = scene.userData.smallOrbit;
    so.angle += so.speed * dt;
    // compute new position on XZ circle around origin at orbitRadius
    const nx = Math.cos(so.angle) * so.orbitRadius;
    const nz = Math.sin(so.angle) * so.orbitRadius;
    // keep Y aligned with base hit cylinder top (use stored topY if available)
    const topY = (so.hit && so.hit.userData && so.hit.userData.topY) ? so.hit.userData.topY : 4.0;
    // update hit position
    const newHitY = topY - (so.vis.geometry.parameters.height / 2);
    so.hit.position.set(nx, newHitY, nz);
    // compute movement delta since last frame and, if the player is standing on this platform, move the player with it
    const newPos = so.hit.position.clone();
    const delta = newPos.clone().sub(so.prevPos || newPos.clone());
    if(playerOnPlatform === so.hit && !playerLockedToSmall){
      // apply horizontal delta to keep player riding the platform (normal unattached behavior)
      camera.position.x += delta.x;
      camera.position.z += delta.z;
      // also nudge Y slightly if platform Y changed (keeps player glued vertically)
      camera.position.y += delta.y;
    } else if(playerLockedToSmall && playerOnPlatform === so.hit){
      // When player is locked to the small platform, enforce the locked offset so the player cannot slide or fall off.
      camera.position.x = so.hit.position.x + smallLockOffset.x;
      camera.position.z = so.hit.position.z + smallLockOffset.z;
      // ensure the player's Y stays on top of the platform surface
      camera.position.y = so.hit.userData.topY;
    }
    // visual mesh should remain visually offset downward the same amount it was during init
    const visOffset = (so.vis && so.vis.userData && so.vis.userData.visualOnly) ? (so.vis.position.y - so.hit.position.y) : -2.2;
    so.vis.position.set(nx, so.hit.position.y + visOffset, nz);
    // store for next-frame delta
    so.prevPos.copy(newPos);
  }

  // falling detection: start delay and fade only when player falls very far below the main platform
  // compute horizontal distance (still useful for HUD/other logic elsewhere)
  const distFromCenter = Math.hypot(camera.position.x, camera.position.z);
  const now = performance.now();

  if(!isGameOver && !falling){
    // Do NOT start falling simply because the player moved far outward; require a deep fall beneath the main ground.
    // Set a large safe vertical buffer so players can roam or be flung far out without triggering death.
    const FALL_DEATH_DEPTH = 50.0; // how far below GROUND_Y the player must fall to begin death timer
    const FALL_DEATH_Y = GROUND_Y - FALL_DEATH_DEPTH;

    if(camera.position.y < FALL_DEATH_Y){
      // start falling timer
      falling = true;
      fallStart = now;
      fadeProgress = 0;
      fadeEl.style.transition = 'none';
      fadeEl.style.opacity = '0';
    }
  }

  if(falling){
    const t = Math.min(1, (now - fallStart) / fallDelay);
    fadeProgress = t;
    fadeEl.style.transition = 'opacity 0.08s linear';
    fadeEl.style.opacity = String(t);
    if(now - fallStart >= fallDelay){
      // finish fall death
      falling = false;
      fadeEl.style.opacity = '1';
      playerDie('fell off');
      // reset fade quickly
      setTimeout(()=>{ fadeEl.style.opacity = '0'; }, 120);
    } else {
      // while falling, allow slow downward motion
      camera.position.y -= 4 * dt;
    }
  }

  // update FPS and lives display
  if(now - lastTime > 250){
    fpsEl.textContent = `${Math.round(1/dt)} fps   ♥ ${lives}`;
    lastTime = now;
  }

  // update aim marker every frame by raycasting from camera
  const raycaster = new THREE.Raycaster();
  const forwardDir = new THREE.Vector3();
  camera.getWorldDirection(forwardDir);
  raycaster.set(camera.position, forwardDir);
  // check intersections with enemies and the floor objects
  const targets = [];
  for(const e of enemies) if(e.mesh) targets.push(e.mesh);
  for(const obj of objects) targets.push(obj);
  const hits = raycaster.intersectObjects(targets, true);
  if(hits && hits.length > 0){
    const hit = hits[0];
    aimMarker.visible = true;
    aimMarker.position.copy(hit.point);
    // orient marker to surface normal
    const normal = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0,1,0);
    const worldNormal = normal.applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
    // align marker plane to the surface by rotating X axis
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), worldNormal);
    aimMarker.setRotationFromQuaternion(quat);
  } else {
    aimMarker.visible = false;
  }

  // Auto-face behavior for cannonballs when the auto-face upgrade is active for this wave:
  if(autoFaceActive && currentWaveType === 'cannon' && cannonballs.length > 0){
    // choose nearest cannonball
    let nearest = null;
    let nd = Infinity;
    for(const cb of cannonballs){
      if(!cb || !cb.userData || !cb.userData.alive) continue;
      const d = Math.hypot(cb.position.x - camera.position.x, cb.position.z - camera.position.z);
      if(d < nd){ nd = d; nearest = cb; }
    }
    if(nearest){
      // 50% of the frames we snap the yaw to face toward that cannonball's XZ position
      if(Math.random() < 0.5){
        const dx = nearest.position.x - camera.position.x;
        const dz = nearest.position.z - camera.position.z;
        const ang = Math.atan2(dx, dz); // compute yaw to look toward target
        // set camera yaw (rotation.y) directly so view faces the cannonball horizontally
        camera.rotation.set(camera.rotation.x, ang, camera.rotation.z, 'YXZ');
      }
    }
  }

  renderer.render(scene, camera);
  // render HUD preview on top if available (keeps same framerate)
  if(hudRenderer && hudScene && hudCam){
    // simple idle rotation animation for the visible HUD item
    if(hudScene.userData) hudScene.userData.time += clock.getDelta();
    for(const k of Object.keys(hudItems || {})){
      const it = hudItems[k];
      if(!it) continue;
      if(it.visible){
        it.rotation.y += 0.01; // slow spin
      }
    }
    // ensure camera aspect matches square preview
    hudCam.aspect = 1;
    hudCam.updateProjectionMatrix();
    hudRenderer.render(hudScene, hudCam);
  }
}
function onWindowResize(){
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

/**
 * Clear all current enemies and spawn a fixed number at the arena center.
 * This keeps the spawn logic centralized for respawns.
 */
function respawnEnemies(count = 2){
  // remove existing enemies from scene
  for(const e of enemies){
    if(e.mesh){
      scene.remove(e.mesh);
    }
  }
  enemies = [];
  // spawn the requested number near center with small offsets
  for(let i=0;i<count;i++){
    const offset = new THREE.Vector3((Math.random()-0.5)*2, 4.0, (Math.random()-0.5)*2);
    createEnemy(new THREE.Vector3(0, 4.0, 0).add(offset));
  }
}

/**
 * Centralized wave completion handler used by multiple places that can finish a wave.
 * Advances waveStage, shows notification, grants a life, and switches wave type with
 * consistent cleanup of enemies and cannonballs.
 */
function handleWaveCompletion(){
  // Do not award kills for the forced despawn: record zero kills this wave for stats
  killsThisWave = 0;
  highScore = Math.max(highScore, killCount);

  // prepare for upgrade UI flow
  awaitingUpgrade = true;
  // reward a life (still give the life, but player may spend on upgrades)
  lives = Math.min(9999, lives + 1);

  // suppress kill accounting while we immediately clear all enemies for the upgrade flow
  suppressKills = true;

  // Clear any active single-wave upgrades now that the wave has finished so they don't persist beyond one wave.
  // Restore time/jump/autoFace defaults immediately.
  activeUpgrades = { slowMo:false, jumpBoost:false, autoFace:false };
  timeScale = 1.0;
  jumpMultiplier = 1.0;
  autoFaceActive = false;

  // show wave notification briefly
  const w = document.getElementById('waveNotify');
  if(w){
    w.style.display = 'block';
    setTimeout(()=>{ w.style.display = 'none'; }, 1200);
  }

  // immediately despawn all enemies so they cannot hurt the player while viewing upgrades
  // and ensure no extra kills are credited by not modifying kill counters here
  invulnerableUntil = performance.now() + 99999; // long immunity until upgrades/stats complete
  for(const e of enemies){
    if(e.mesh){
      e.mesh.userData.alive = false;
      e.mesh._despawned = true;
      scene.remove(e.mesh);
    }
  }
  enemies = [];

  // center the player in the arena (move to center at a visible height) and reset view
  const GROUND_Y = 4.0;
  camera.position.set(0, 18, 0);
  camera.rotation.set(0,0,0,'YXZ');

  // stop cannon activity and clear cannonballs while upgrading
  cannonActive = false;
  for(const cb of cannonballs){ if(cb) scene.remove(cb); }
  cannonballs = [];

  // reset wave kill counter so new wave starts fresh after upgrade/stats
  killsSinceWaveStart = 0;

  // show upgrade UI
  const up = document.getElementById('upgradeScreen');
  const upLives = document.getElementById('upgradeLives');
  if(up && upLives){
    // show totalKills as the player's currency in the upgrade UI
    upLives.textContent = String(totalKills);
    up.style.display = 'flex';
  }
}

// spawn a single cannonball far away that flies toward the player like a cannon shot
function spawnNextCannonball(count = 1){
  // ensure no normal enemies are present
  for(const e of enemies){
    if(e.mesh){ scene.remove(e.mesh); e.mesh._despawned = true; }
  }
  enemies = [];

  const loader = new THREE.TextureLoader();
  const faceTex = loader.load('/RickCaldwell.jpg');
  faceTex.encoding = THREE.sRGBEncoding;
  const mat = new THREE.MeshStandardMaterial({map: faceTex, metalness:0.6, roughness:0.4});
  const geo = new THREE.SphereGeometry(1.1, 12, 10);

  // simple random-name generator mirrored from createEnemy (small local list)
  function randomCannonName(){
    const names = ['Caesar','Tesla','Genghis','Ada','Napoleon','SirSnack','Ziggy','DrNoodle','Mango','Homer','Beowulf','Plato','LadyPip','BaronVonBean'];
    return names[Math.floor(Math.random()*names.length)];
  }

  // helper to make a tiny name plane for cannonballs
  function makeSmallLabel(name){
    const canvas = document.createElement('canvas');
    const size = 128;
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,size,size);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect = ctx.roundRect || function(x,y,w,h,r){ ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); };
    ctx.roundRect(8, 48, 112, 32, 8);
    ctx.fill();
    ctx.font = 'bold 18px system-ui, Arial';
    ctx.fillStyle = '#ffd';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, size/2, 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({map: tex, transparent: true, side: THREE.DoubleSide});
    const geo = new THREE.PlaneGeometry(1.2, 0.35);
    return new THREE.Mesh(geo, mat);
  }

  for(let n=0;n<count;n++){
    // compute spawn position far off-map in a random direction, above the ground
    const angle = Math.random() * Math.PI * 2;
    const spawnDist = 80;
    const sx = Math.cos(angle) * spawnDist;
    const sz = Math.sin(angle) * spawnDist;
    const sy = 12 + Math.random() * 6;

    const ball = new THREE.Mesh(geo, mat);
    ball.position.set(sx, sy, sz);
    ball.userData = {alive: true, vel: new THREE.Vector3()};
    scene.add(ball);
    // set initial homing velocity toward player's current position (no gravity)
    const target = new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z);
    const dir = new THREE.Vector3().subVectors(target, ball.position).normalize();
    // apply the effective speed from base * multiplier
    const effectiveCannonSpeed = cannonSpeedBase * cannonCurrentSpeedMultiplier;
    ball.userData.vel.copy(dir.multiplyScalar(effectiveCannonSpeed));
    ball.castShadow = false;

    // attach a small random name label to the cannonball
    const cname = randomCannonName();
    const clabel = makeSmallLabel(cname);
    clabel.position.set(0, 1.6, 0);
    clabel.userData.isCannonLabel = true;
    ball.add(clabel);
    ball.userData.name = cname;

    cannonballs.push(ball);
  }

  // ensure arrow element exists and cache it
  if(!cannonArrowEl) cannonArrowEl = document.getElementById('cannonArrow');
}

// handle player death and respawn
function playerDie(reason = 'fell'){
  const now = performance.now();
  if(now < invulnerableUntil) return;
  invulnerableUntil = now + 800;

  lives = Math.max(0, lives - 1);
  fpsEl.textContent = `${Math.round(1/Math.max(clock.getDelta(),1e-6))} fps   ♥ ${lives}`;

  if(lives <= 0){
    isGameOver = true;
    // remove all enemies from the scene when game over
    respawnEnemies(0);
    overlayText.textContent = `You lost all lives — ${reason}`;
    // ensure respawn button is visible (it may be hidden during pause)
    try { respawnBtn.style.display = ''; } catch(e){}
    // hide the restart-round control in game-over mode
    try { const restartBtn = document.getElementById('restartRoundBtn'); if(restartBtn) restartBtn.style.display = 'none'; } catch(e){}
    overlay.style.display = 'flex';
  } else {
    // auto respawn at center higher so player visibly falls back onto the platform
    // keep existing enemies intact — do not despawn or respawn enemies when losing a single life
    camera.position.set(0, 18, 0);
    camera.rotation.set(0,0,0,'YXZ');
  }
}

  // P key: remove looked-at enemy and count as a kill (also spawn 3 new enemies)
window.addEventListener('keydown', (ev)=>{
  if(ev.code !== 'KeyP') return;
  // raycast forward from camera to find targeted enemy or cannonball
  const rc = new THREE.Raycaster();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  rc.set(camera.position, dir);

  // If cannon wave active, allow P to remove any cannonball as well
  if(currentWaveType === 'cannon' && cannonballs.length > 0){
    for(let i = cannonballs.length - 1; i >= 0; --i){
      const cb = cannonballs[i];
      const hits = rc.intersectObject(cb, true);
      if(hits && hits.length > 0){
        // destroying a cannonball with P counts as a kill and speeds them up
        scene.remove(cb);
        cb.userData.alive = false;
        cannonballs.splice(i,1);
        registerKill();
        if(!suppressKills) cannonKillsThisWave += 1;
        // speed multiplier accumulates; recompute current speed from base * multiplier
        cannonCurrentSpeedMultiplier *= 1.05;
        cannonCurrentSpeed = cannonSpeedBase * cannonCurrentSpeedMultiplier;
        const cannonWaveThresholdP = (currentWaveType === 'normal') ? 10 : 15;
        if(currentWaveType === 'cannon' && cannonKillsThisWave < cannonWaveThresholdP) spawnNextCannonball(1);

        // check for end of wave depending on current wave type
        const waveThresholdP = getWaveKillThreshold();
        if(killsSinceWaveStart >= waveThresholdP){
    handleWaveCompletion();
  }
        return;
      }
    }
  }

  const targets = enemies.map(e=>e.mesh);
  if(targets.length === 0) return;
  const hits = rc.intersectObjects(targets, true);
  if(!hits || hits.length === 0) return;
  // find top-level enemy mesh from hit (in case a child was hit)
  let hitMesh = hits[0].object;
  while(hitMesh && !targets.includes(hitMesh) && hitMesh.parent) hitMesh = hitMesh.parent;
  if(!hitMesh) return;
  // ensure it's a living enemy
  const enemyIndex = enemies.findIndex(en => en.mesh === hitMesh);
  if(enemyIndex === -1) return;
  const enemyEntry = enemies[enemyIndex];
  if(!enemyEntry.mesh.userData || !enemyEntry.mesh.userData.alive) return;

  // despawn and count as kill
  // If this enemy grants a grenade, give it now (increment inventory and update slot 3)
  if(enemyEntry.mesh.userData && (enemyEntry.mesh.userData.givesGrenadeCount || enemyEntry.mesh.userData.givesGrenade)){
    const giveCount = Number(enemyEntry.mesh.userData.givesGrenadeCount || (enemyEntry.mesh.userData.givesGrenade ? 1 : 0)) || 0;
    grenadeCount = (grenadeCount || 0) + giveCount;
    const slot3 = document.querySelector('.hotbar-slot[data-slot="3"]');
    if(slot3){
      slot3.classList.remove('empty');
      let main = slot3.querySelector('.gren-label');
      if(!main){
        main = document.createElement('div');
        main.className = 'gren-label';
        main.style.fontWeight = '800';
        slot3.insertBefore(main, slot3.querySelector('.slot-label'));
      }
      main.textContent = `Gren x${grenadeCount}`;
      slot3.dataset.item = 'grenade';
    }
  }

  enemyEntry.mesh.userData.alive = false;
  enemyEntry.mesh._despawned = true;
  scene.remove(enemyEntry.mesh);

  // register the kill (respects suppression)
  registerKill();

  // wave completion logic uses killsSinceWaveStart and current wave type threshold
  const waveThresholdKey = getWaveKillThreshold();
  if(killsSinceWaveStart >= waveThresholdKey){
    waveStage += 1;
    killsSinceWaveStart = 0;
    const w = document.getElementById('waveNotify');
    if(w){
      w.style.display = 'block';
      setTimeout(()=>{ w.style.display = 'none'; }, 2200);
    }
    // (wave changes handled in the main loop)
  }

  // spawn exactly 3 new enemies near the center with small random offsets (only during normal waves)
  // Do not spawn while the upgrade/stats flow is active (awaitingUpgrade).
  if(!awaitingUpgrade && currentWaveType === 'normal'){
    for(let i=0;i<3;i++){
      const offset = new THREE.Vector3((Math.random()-0.5)*2, 0, (Math.random()-0.5)*2);
      createEnemy(new THREE.Vector3(0, 4.0, 0).add(offset));
    }
  }

  // remove from active enemies list
  enemies = enemies.filter(e => !e.mesh._despawned);
});

 /* Escape: require double-press within a short window to toggle pause (prevents accidental single-press pauses)
   First press briefly highlights the hint; second press within the window toggles pause exactly like before. */
let _lastEscAt = -Infinity;
const _ESC_WINDOW_MS = 450;
window.addEventListener('keydown', (ev)=>{
  if(ev.code !== 'Escape') return;
  const now = performance.now();
  // if second press within window -> toggle pause
  if(now - _lastEscAt <= _ESC_WINDOW_MS){
    paused = !paused;
    const restartBtn = document.getElementById('restartRoundBtn');
    if(paused){
      // show overlay as pause indicator, hide respawn button while paused, show restart round option
      overlayText.textContent = 'Paused';
      if(respawnBtn) respawnBtn.style.display = 'none';
      if(restartBtn) restartBtn.style.display = '';
      overlay.style.display = 'flex';
    } else {
      // unpause: hide overlay and restore respawn button visibility
      overlay.style.display = 'none';
      if(respawnBtn) respawnBtn.style.display = '';
      if(restartBtn) restartBtn.style.display = 'none';
      overlayText.textContent = 'You lost all lives';
      // short invulnerability grace
      invulnerableUntil = performance.now() + 1200;
    }
    _lastEscAt = -Infinity; // reset
    return;
  }
  // first press: record time and give immediate subtle feedback via esc hint
  _lastEscAt = now;
  const escHint = document.getElementById('escHint');
  if(escHint){
    escHint.style.transition = 'transform 140ms ease, background 220ms ease';
    escHint.style.transform = 'translateX(-50%) scale(1.03)';
    escHint.style.background = 'rgba(255,255,255,0.06)';
    setTimeout(()=>{
      if(escHint){
        escHint.style.transform = 'translateX(-50%)';
        escHint.style.background = '';
      }
    }, 220);
  }
  // if no second press arrives within the window, silently expire the pending press
  setTimeout(()=>{
    if(performance.now() - _lastEscAt > _ESC_WINDOW_MS){
      _lastEscAt = -Infinity;
    }
  }, _ESC_WINDOW_MS + 10);
});

  // implement playerGunShoot to be used by hotbar fire and G key (5s cooldown, ~30x stronger than sword)
  function playerGunShoot(){
    if(paused) return;
    const now = performance.now();

    // Slot 2 has been removed as a functional gun: disable gun actions when slot 2 is selected.
    if(activeHotbarSlot === 2) return;

    // determine currently equipped item id from the active hotbar slot (supports long-range slot 4)
    const activeSlotEl = document.querySelector(`.hotbar-slot[data-slot="${activeHotbarSlot}"]`);
    const itemId = activeSlotEl && activeSlotEl.dataset ? (activeSlotEl.dataset.item || '') : '';

    // gather alive enemy list
    const aliveEnemies = enemies.filter(en=>en.mesh && en.mesh.userData && en.mesh.userData.alive);

    // helper: apply impulse to an enemy
    function applyGunImpulse(targetMesh, power){
      const away = new THREE.Vector3().subVectors(targetMesh.position, camera.position);
      away.y = 0;
      away.normalize();
      // respect incoming knock resistance on the target (reduce applied impulse if configured)
      const resistance = (targetMesh.userData && (typeof targetMesh.userData.knockResistance === 'number')) ? targetMesh.userData.knockResistance : 1.0;
      const effectivePower = power * resistance;
      targetMesh.userData.vel.x = away.x * effectivePower;
      targetMesh.userData.vel.z = away.z * effectivePower;
      targetMesh.userData.vel.y = 0;
      targetMesh.userData.pulse = 0;
    }

    // Enforce special "slot 2" behavior: while slot 2 is active, disable all melee attributes and
    // perform an instant-kill on the best-aligned enemy (infinite-range) with a fixed 5s cooldown.
    if(activeHotbarSlot === 2){
      // neutralize melee capabilities while slot 2 is active
      ['sword','plasma_blade','stealth_sword','warhammer','default'].forEach(k=>{
        if(!itemStats[k]) itemStats[k] = {};
        itemStats[k].type = 'melee';
        itemStats[k].meleePower = 0;
        itemStats[k].meleeUp = 0;
        itemStats[k].meleeReach = 0;
      });

      const SLOT2_BASE_COOLDOWN = 5000;
      const effectiveCooldownMsSlot2 = Math.max(0, SLOT2_BASE_COOLDOWN - (cooldownReduction || 0));
      if(now - lastGunFire < effectiveCooldownMsSlot2){
        // cooldown feedback
        const slot = document.querySelector('.hotbar-slot[data-slot="2"]');
        if(slot){ slot.style.transform = 'scale(0.98)'; setTimeout(()=>{ slot.style.transform = ''; }, 140); }
        return;
      }

      // choose target from all alive enemies (infinite-range)
      const aliveEnemiesAll = aliveEnemies;
      if(!aliveEnemiesAll || aliveEnemiesAll.length === 0) return;

      const lookDir = new THREE.Vector3(); camera.getWorldDirection(lookDir);
      const forwardXZ = lookDir.clone().setY(0).normalize();

      let best = null;
      let bestAngle = Infinity;
      for(const en of aliveEnemiesAll){
        const toE = new THREE.Vector3(en.mesh.position.x - camera.position.x, 0, en.mesh.position.z - camera.position.z).normalize();
        const a = forwardXZ.angleTo(toE);
        if(a < bestAngle){ bestAngle = a; best = en; }
      }
      // fallback to nearest if alignment fails
      if(!best){
        let nearestD = Infinity;
        for(const en of aliveEnemiesAll){
          const d = camera.position.distanceTo(en.mesh.position);
          if(d < nearestD){ nearestD = d; best = en; }
        }
      }
      if(!best) return;

      // Instant kill: remove target from scene and count as kill (respect suppression)
      try {
        if(best.mesh.userData && (best.mesh.userData.givesGrenadeCount || best.mesh.userData.givesGrenade)){
          // grant configured number of grenades to slot 3 immediately
          const giveCount = Number(best.mesh.userData.givesGrenadeCount || (best.mesh.userData.givesGrenade ? 1 : 0)) || 0;
          grenadeCount = (grenadeCount || 0) + giveCount;
          const slot3 = document.querySelector('.hotbar-slot[data-slot="3"]');
          if(slot3){
            slot3.classList.remove('empty');
            let main = slot3.querySelector('.gren-label');
            if(!main){
              main = document.createElement('div');
              main.className = 'gren-label';
              main.style.fontWeight = '800';
              slot3.insertBefore(main, slot3.querySelector('.slot-label'));
            }
            main.textContent = `Gren x${grenadeCount}`;
            slot3.dataset.item = 'grenade';
          }
        }

        best.mesh.userData.alive = false;
        best.mesh._despawned = true;
        scene.remove(best.mesh);

        // register kill
        registerKill();

        // wave completion bookkeeping for kills that occurred during a wave
        const waveThreshold = getWaveKillThreshold();
        if(killsSinceWaveStart >= waveThreshold){
          handleWaveCompletion();
        }
      } catch(e){
        console.warn('slot2 instant-kill error', e);
      }

      // apply fixed cooldown
      lastGunFire = now;
      gunCooldownMs = SLOT2_BASE_COOLDOWN;

      // UI cooldown indicator on slot 2
      const slotEl = document.querySelector('.hotbar-slot[data-slot="2"]');
      if(slotEl){
        const label = slotEl.querySelector('.slot-label');
        const orig = label ? label.textContent : '';
        slotEl.style.opacity = '0.5';
        if(label) label.textContent = String(Math.ceil(Math.max(0, (gunCooldownMs - (cooldownReduction||0))/1000)));
        const iv = setInterval(()=>{
          const remaining = Math.max(0, Math.ceil(((gunCooldownMs - (performance.now() - lastGunFire)) - (cooldownReduction||0))/1000));
          if(label) label.textContent = String(remaining);
          if(performance.now() - lastGunFire >= gunCooldownMs - (cooldownReduction||0)){
            clearInterval(iv);
            slotEl.style.opacity = '';
            gunCooldownMs = itemStats.gun.gunCooldownMs || 5000;
            if(label) label.textContent = orig || '2';
          }
        }, 200);
      }
      return;
    }

    // cooldown check (some weapons set their own cooldowns below)
    const effectiveCooldownMs = Math.max(0, (gunCooldownMs || 0) - (cooldownReduction || 0));
    if(now - lastGunFire < effectiveCooldownMs){
      const slot = document.querySelector('.hotbar-slot[data-slot="2"]');
      if(slot){ slot.style.transform = 'scale(0.98)'; setTimeout(()=>{ slot.style.transform = ''; }, 140); }
      return;
    }

    // prepare forward direction once for angle-based selection
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const forwardXZ = dir.clone().setY(0).normalize();

    // INFINITE-RANGE RAILGUN: hit up to 2 best-aligned enemies anywhere in the scene
    if(itemId === 'railgun'){
      const stats = itemStats.railgun || itemStats.gun || itemStats.default;
      const power = stats.gunPower || itemStats.default.gunPower;
      // rank alive enemies by angle to view direction, prefer those most directly ahead
      const list = aliveEnemies.map(en=>{
        const toE = new THREE.Vector3(en.mesh.position.x - camera.position.x, 0, en.mesh.position.z - camera.position.z).normalize();
        const angle = forwardXZ.angleTo(toE);
        return {en, angle};
      });
      list.sort((a,b)=>a.angle - b.angle);
      for(let i=0;i<Math.min(2, list.length); i++){
        applyGunImpulse(list[i].en.mesh, power);
      }
      lastGunFire = now;
      // minor visual feedback
      const slot = document.querySelector('.hotbar-slot[data-slot="2"]');
      if(slot){ slot.style.opacity = '0.65'; setTimeout(()=>{ slot.style.opacity = ''; }, 220); }
      return;
    }

    // INFINITE-RANGE SNIPER: deal 5 instant hits to the best-aligned enemy (or to first if none) then long cooldown
    if(itemId === 'sniper_rifle'){
      const stats = itemStats.sniper_rifle || itemStats.gun || itemStats.default;
      const power = stats.gunPower || itemStats.default.gunPower;
      if(aliveEnemies.length === 0) return;
      // pick best-aligned enemy
      let best = null; let bestA = Infinity;
      for(const en of aliveEnemies){
        const toE = new THREE.Vector3(en.mesh.position.x - camera.position.x, 0, en.mesh.position.z - camera.position.z).normalize();
        const a = forwardXZ.angleTo(toE);
        if(a < bestA){ bestA = a; best = en; }
      }
      if(!best) best = aliveEnemies[0];
      for(let s=0;s<5;s++) applyGunImpulse(best.mesh, power);
      lastGunFire = now;
      gunCooldownMs = 7500;
      const slot = document.querySelector('.hotbar-slot[data-slot="2"]');
      if(slot){
        const label = slot.querySelector('.slot-label');
        const original = label ? label.textContent : '';
        slot.style.opacity = '0.5';
        if(label) label.textContent = '8';
        const iv = setInterval(()=>{
          const remaining = Math.max(0, Math.ceil(((gunCooldownMs - (performance.now() - lastGunFire)) - (cooldownReduction||0))/1000));
          if(label) label.textContent = String(remaining);
          if(performance.now() - lastGunFire >= gunCooldownMs - (cooldownReduction||0)){
            clearInterval(iv);
            slot.style.opacity = '';
            gunCooldownMs = itemStats.gun.gunCooldownMs || 5000;
            if(label) label.textContent = original || '2';
          }
        }, 200);
      }
      return;
    }

    // INFINITE-RANGE EXPLOSIVE ARROW: pick up to 5 closest enemies to an impact point far along view
    if(itemId === 'explosive_arrow'){
      const stats = itemStats.explosive_arrow || itemStats.default;
      const power = (stats.gunPower || itemStats.default.gunPower) * 1.2;
      if(aliveEnemies.length === 0) return;
      // compute an impact point far along view (acts like infinite range)
      const impactPoint = camera.position.clone().add(dir.clone().multiplyScalar(400));
      // choose 5 closest enemies to that point
      const list = aliveEnemies.map(en=>({en, d: impactPoint.distanceTo(en.mesh.position)}));
      list.sort((a,b)=>a.d - b.d);
      const chosen = list.slice(0,5);
      for(const c of chosen){
        const e = c.en.mesh;
        const away = new THREE.Vector3().subVectors(e.position, impactPoint).setY(0).normalize();
        if(!isNaN(away.x)){
          e.userData.vel.x = away.x * power;
          e.userData.vel.z = away.z * power;
          e.userData.vel.y = 6.0;
          e.userData.pulse = 0;
        }
      }
      lastGunFire = now;
      gunCooldownMs = 11000;
      const slot = document.querySelector('.hotbar-slot[data-slot="2"]');
      if(slot){
        const label = slot.querySelector('.slot-label');
        const original = label ? label.textContent : '';
        slot.style.opacity = '0.5';
        if(label) label.textContent = '11';
        const iv = setInterval(()=>{
          const remaining = Math.max(0, Math.ceil(((gunCooldownMs - (performance.now() - lastGunFire)) - (cooldownReduction||0))/1000));
          if(label) label.textContent = String(remaining);
          if(performance.now() - lastGunFire >= gunCooldownMs - (cooldownReduction||0)){
            clearInterval(iv);
            slot.style.opacity = '';
            gunCooldownMs = itemStats.gun.gunCooldownMs || 5000;
            if(label) label.textContent = original || '2';
          }
        }, 200);
      }
      return;
    }

    // INFINITE-RANGE GRAPPLING HOOK: pick best-aligned enemy anywhere to pull/teleport to and apply melee knockback
    if(itemId === 'grappling_hook'){
      const meleePower = itemStats.default.meleePower;
      if(aliveEnemies.length === 0){
        // if no enemy, just pull along view
        const point = camera.position.clone().add(dir.clone().multiplyScalar(40));
        camera.position.set(point.x, point.y, point.z);
        lastGunFire = now;
        gunCooldownMs = 3000;
        const slot = document.querySelector('.hotbar-slot[data-slot="2"]');
        if(slot){ slot.style.opacity = '0.6'; setTimeout(()=>{ slot.style.opacity = ''; }, 300); }
        return;
      }
      // pick best-aligned enemy by angle
      let best = null; let bestA = Infinity;
      for(const en of aliveEnemies){
        const toE = new THREE.Vector3(en.mesh.position.x - camera.position.x, 0, en.mesh.position.z - camera.position.z).normalize();
        const a = forwardXZ.angleTo(toE);
        if(a < bestA){ bestA = a; best = en; }
      }
      if(best){
        const hitMesh = best.mesh;
        const away = new THREE.Vector3().subVectors(hitMesh.position, camera.position).setY(0).normalize();
        hitMesh.userData.vel.x = away.x * meleePower;
        hitMesh.userData.vel.z = away.z * meleePower;
        hitMesh.userData.vel.y = 5.5;
        hitMesh.userData.pulse = 0;
        camera.position.set(hitMesh.position.x, hitMesh.position.y + 2.2, hitMesh.position.z - away.z*0.8);
      }
      lastGunFire = now;
      gunCooldownMs = 3000;
      const slot = document.querySelector('.hotbar-slot[data-slot="2"]');
      if(slot){ slot.style.opacity = '0.6'; setTimeout(()=>{ slot.style.opacity = ''; }, 300); }
      return;
    }

    // special-case: generic 'gun' in slot 2 should disable interfering upgrades and apply extreme knockback + 5s cooldown
    if(itemId === 'gun'){
      const stats = itemStats.gun || { gunPower: 5000, gunCooldownMs: 5000 };
      const power = stats.gunPower || 5000;
      if(aliveEnemies.length === 0) return;
      // choose best aligned enemy and fling them extremely far (infinite-range)
      let best = null; let bestA = Infinity;
      for(const en of aliveEnemies){
        const toE = new THREE.Vector3(en.mesh.position.x - camera.position.x, 0, en.mesh.position.z - camera.position.z).normalize();
        const a = forwardXZ.angleTo(toE);
        if(a < bestA){ bestA = a; best = en; }
      }
      if(!best) best = aliveEnemies[0];
      // apply a very large impulse so targets are sent far away
      applyGunImpulse(best.mesh, power);
      lastGunFire = now;
      gunCooldownMs = stats.gunCooldownMs || 5000;
      const slot = document.querySelector('.hotbar-slot[data-slot="2"]');
      if(slot){
        const label = slot.querySelector('.slot-label');
        const original = label ? label.textContent : '';
        slot.style.opacity = '0.5';
        if(label) label.textContent = String(Math.ceil((Math.max(0, gunCooldownMs - (cooldownReduction||0)))/1000));
        const iv = setInterval(()=>{
          const remaining = Math.max(0, Math.ceil(((gunCooldownMs - (performance.now() - lastGunFire)) - (cooldownReduction||0))/1000));
          if(label) label.textContent = String(remaining);
          if(performance.now() - lastGunFire >= gunCooldownMs - (cooldownReduction||0)){
            clearInterval(iv);
            slot.style.opacity = '';
            if(label) label.textContent = original || '2';
          }
        }, 200);
      }
      return;
    }

    // fallback / regular gun: single best-aligned enemy (infinite-ish behavior for consistency)
    {
      const stats = getActiveItemStats();
      const gunBase = stats.gunPower || itemStats.default.gunPower;
      const power = gunBase;
      if(aliveEnemies.length === 0) return;
      let best = null; let bestA = Infinity;
      for(const en of aliveEnemies){
        const toE = new THREE.Vector3(en.mesh.position.x - camera.position.x, 0, en.mesh.position.z - camera.position.z).normalize();
        const a = forwardXZ.angleTo(toE);
        if(a < bestA){ bestA = a; best = en; }
      }
      if(!best) return;
      applyGunImpulse(best.mesh, power);
      lastGunFire = now;
      const slot = document.querySelector('.hotbar-slot[data-slot="2"]');
      if(slot){
        const label = slot.querySelector('.slot-label');
        const original = label ? label.textContent : '';
        slot.style.opacity = '0.5';
        if(label) label.textContent = String(Math.ceil((Math.max(0, gunCooldownMs - (cooldownReduction||0)))/1000));
        const iv = setInterval(()=>{
          const remaining = Math.max(0, Math.ceil(((gunCooldownMs - (performance.now() - lastGunFire)) - (cooldownReduction||0))/1000));
          if(label) label.textContent = String(remaining);
          if(performance.now() - lastGunFire >= gunCooldownMs - (cooldownReduction||0)){
            clearInterval(iv);
            slot.style.opacity = '';
            if(label) label.textContent = original || '2';
          }
        }, 200);
      }
    }
  }

 // G key: use same gun function so hotbar and key behavior match
 window.addEventListener('keydown', (ev)=>{
   if(ev.code !== 'KeyG') return;
   playerGunShoot();
 });

 // playerThrowGrenade: long-range throw that travels to the aimed point and is one-time use
 function playerThrowGrenade(){
   if(paused) return;
   const now = performance.now();
   if(now - lastGrenadeFire < grenadeCooldownMs) {
     // cooldown feedback
     const slot = document.querySelector('.hotbar-slot[data-slot="3"]');
     if(slot){ slot.style.transform = 'scale(0.98)'; setTimeout(()=>{ slot.style.transform = ''; },140); }
     return;
   }
   if(!grenadeCount || grenadeCount <= 0) return;

   // consume one grenade
   grenadeCount = Math.max(0, grenadeCount - 1);
   const slot3 = document.querySelector('.hotbar-slot[data-slot="3"]');
   if(slot3){
     if(grenadeCount === 0){
       slot3.classList.add('empty');
       slot3.dataset.item = '';
       const main = slot3.querySelector('.gren-label');
       if(main) main.parentNode.removeChild(main);
     } else {
       const main = slot3.querySelector('.gren-label');
       if(main) main.textContent = `Gren x${grenadeCount}`;
     }
   }

   lastGrenadeFire = now;

   // create grenade mesh
   const geo = new THREE.SphereGeometry(0.28, 10, 10);
   const mat = new THREE.MeshStandardMaterial({color:0xffcc44, metalness:0.3, roughness:0.6, emissive:0x442200});
   const gmesh = new THREE.Mesh(geo, mat);
   // start in front of camera
   const start = camera.position.clone();
   const forward = new THREE.Vector3();
   camera.getWorldDirection(forward);
   start.add(forward.clone().multiplyScalar(1.6));
   gmesh.position.copy(start);
   scene.add(gmesh);

   // determine target point: prefer precise raycast hit (long range), otherwise a far point along view
   const rc = new THREE.Raycaster();
   rc.set(camera.position, forward);
   rc.far = 1e6;
   const targets = enemies.map(e=>e.mesh).concat(objects);
   const hits = rc.intersectObjects(targets, true);
   let targetPoint;
   if(hits && hits.length > 0){
     targetPoint = hits[0].point.clone();
   } else {
     targetPoint = camera.position.clone().add(forward.clone().multiplyScalar(400)); // far reach
   }

   // add to grenade list with 1 second travel
   grenades.push({
     mesh: gmesh,
     startTime: performance.now(),
     duration: 1000,
     from: start.clone(),
     to: targetPoint.clone(),
     alive: true
   });
 }

  // Hotbar selection state and input handlers
  // HOTBAR_SLOTS is dynamic: starts at 7, may increase when player purchases an extra hotbar slot.
  let HOTBAR_SLOTS = 7;

  // Ensure DOM has the requested number of hotbar slot elements (creates slot elements for indices >7)
  function ensureHotbarSlots(count){
    count = Math.max(7, Math.floor(count || 7));
    // if we already have enough slots, just update the global
    if(count <= HOTBAR_SLOTS) { HOTBAR_SLOTS = count; return; }
    const hotbar = document.getElementById('hotbar');
    if(!hotbar) { HOTBAR_SLOTS = count; return; }
    // create extra slots (append to the last group for simplicity)
    for(let i = HOTBAR_SLOTS + 1; i <= count; i++){
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot empty';
      slot.dataset.slot = String(i);
      slot.title = `Slot ${i}`;
      slot.style.minWidth = slot.style.minHeight = ''; // let CSS control sizing
      const label = document.createElement('div');
      label.className = 'slot-label';
      label.textContent = String(i);
      slot.appendChild(label);
      // append into the hotbar container (keeps layout simple by appending at the end)
      hotbar.appendChild(slot);
    }
    HOTBAR_SLOTS = count;
  }

  // Convenience helper called when the extra slot purchase completes
  function addExtraHotbarSlot(){
    // only add if we haven't already
    if(HOTBAR_SLOTS >= 8) return;
    ensureHotbarSlots(8);
    // persist the new hotbar layout (empty slot appended)
    try {
      const hotbar = [];
      document.querySelectorAll('.hotbar-slot').forEach((el)=> hotbar.push(el.dataset.item || ''));
      saveState({ totalKills, hotbar, permanentUpgrades, purchasedItems, inventory });
    } catch(e){}
    // minor visual feedback
    const newSlotEl = document.querySelector(`.hotbar-slot[data-slot="8"]`);
    if(newSlotEl){
      newSlotEl.style.transform = 'translateY(-6px) scale(1.03)';
      setTimeout(()=>{ newSlotEl.style.transform = ''; }, 260);
    }
  }
  function updateHotbarVisuals(){
    for(let i=1;i<=HOTBAR_SLOTS;i++){
      const el = document.querySelector(`.hotbar-slot[data-slot="${i}"]`);
      if(!el) continue;
      if(i === activeHotbarSlot){
        el.style.boxShadow = '0 8px 28px rgba(40,200,120,0.22), 0 2px 6px rgba(0,0,0,0.5)';
        el.style.transform = 'translateY(-4px)';
        el.style.borderColor = 'rgba(40,200,120,0.35)';
      } else {
        el.style.boxShadow = '';
        el.style.transform = '';
        el.style.borderColor = '';
      }
    }

    // Determine which HUD preview to show based on the actual item in the active slot.
    // Mapping: handhelds & potions -> avocado texture (hudItems.grenade),
    // short range -> sword texture (hudItems.sword),
    // long range -> water gun texture (hudItems.gun).
    function getPreviewKeyForItem(itemId){
      if(!itemId) return null;
      const id = String(itemId).toLowerCase();
      // long range examples
      const longRange = ['sniper_rifle','explosive_arrow','railgun','grappling_hook','tele_shot'];
      // short range examples
      const shortRange = ['plasma_blade','stealth_sword','warhammer','sword'];
      // potions
      const potions = ['regen_elixir','health_potion_shop','energy_tonic'];
      // handhelds
      const handhelds = ['smoke_bomb','flashbang','handheld_1','handheld_2','handheld_3'];

      if(longRange.includes(id)) return 'gun';
      if(shortRange.includes(id)) return 'sword';
      if(potions.includes(id)) return 'grenade'; // avocado texture used for potions per mapping
      if(handhelds.includes(id)) return 'grenade'; // avocado texture for handhelds
      // fallback heuristics
      if(id.includes('sword') || id.includes('blade') || id.includes('plasma')) return 'sword';
      if(id.includes('gun') || id.includes('rifle') || id.includes('rail') || id.includes('grap')) return 'gun';
      if(id.includes('potion') || id.includes('elixir') || id.includes('bomb') || id.includes('hand')) return 'grenade';
      return null;
    }

    // hide all first
    if(hudItems){
      for(const k of Object.keys(hudItems)) if(hudItems[k]) hudItems[k].visible = false;
      const activeSlotEl = document.querySelector(`.hotbar-slot[data-slot="${activeHotbarSlot}"]`);
      let previewKey = null;
      if(activeSlotEl && activeSlotEl.dataset){
        previewKey = getPreviewKeyForItem(activeSlotEl.dataset.item || '');
      }
      // Never show the HUD preview while slot 2 is active (explicit requirement).
      if(activeHotbarSlot === 2){
        previewKey = null;
      }
      // if no mapping, fall back to slot-index defaults (older behavior), but skip slot 2
      if(!previewKey){
        if(activeHotbarSlot === 1) previewKey = 'sword';
        else if(activeHotbarSlot === 3) previewKey = 'grenade';
      }
      if(previewKey && hudItems[previewKey]) hudItems[previewKey].visible = true;

      // small subtle scaling/rotation feedback when switching
      const activeMesh = hudItems[previewKey] || hudItems.sword;
      if(activeMesh){
        activeMesh.scale.setScalar(1.0);
        activeMesh.rotation.y = 0.35;
      }
    }
  }

  function selectHotbarSlot(n){
    const wanted = Math.floor(n);
    const clamped = Math.max(1, Math.min(HOTBAR_SLOTS, wanted));
    activeHotbarSlot = clamped;
    updateHotbarVisuals();
    // optional: provide brief haptic / visual feedback when selecting
    const el = document.querySelector(`.hotbar-slot[data-slot="${activeHotbarSlot}"]`);
    if(el){
      el.style.transition = 'transform 120ms ease';
      el.style.transform = 'translateY(-6px) scale(1.02)';
      setTimeout(()=>{ updateHotbarVisuals(); el.style.transition = ''; }, 140);
    }
  }

  // helper to detect whether the currently equipped hotbar slot is the stealth sword
  function hasStealthEquipped(){
    const stats = getActiveItemStats();
    // consider stealth equipped if the active item has a stealthSpeedMult or is explicitly stealth_sword
    return !!(stats && (stats.stealthSpeedMult || stats === itemStats.stealth_sword));
  }

  // click-to-select for hotbar slots
  document.addEventListener('click', (ev)=>{
    const slot = ev.target.closest && ev.target.closest('.hotbar-slot');
    if(slot && slot.dataset && slot.dataset.slot){
      const idx = Number(slot.dataset.slot);
      if(!isNaN(idx)) selectHotbarSlot(idx);
    }
  });

  // keybinds: Digit1.. and Numpad1.. equip slots up to HOTBAR_SLOTS
  window.addEventListener('keydown', (ev)=>{
    if(ev.code.startsWith('Digit') || ev.code.startsWith('Numpad')){
      let n = null;
      if(ev.code.startsWith('Digit')) n = Number(ev.code.replace('Digit',''));
      if(ev.code.startsWith('Numpad')) n = Number(ev.code.replace('Numpad',''));
      if(n !== null && !isNaN(n) && n >=1 && n <= HOTBAR_SLOTS){
        selectHotbarSlot(n);
      }
    }
  });

  // initialize visuals once DOM is ready
  setTimeout(()=>{
    // apply saved state (currency, hotbar, upgrades) before visuals initialize
    applySavedState();
    updateHotbarVisuals();

    // Show the start screen overlay at launch. Left arrow opens shop, Right arrow starts the battle.
    const startScreenEl = document.getElementById('startScreen');
    if(startScreenEl){
      startScreenEl.style.display = 'flex';
    }
    // ensure overlay (game-over) is hidden while start screen is active
    if(overlay) overlay.style.display = 'none';

    function startGameFromStart(){
      // hide start screen and unpause game, respawn and center player
      if(startScreenEl) startScreenEl.style.display = 'none';
      paused = false;
      isGameOver = false;
      overlay.style.display = 'none';
      lives = Math.max(1, lives);
      camera.position.set(0,18,0);
      camera.rotation.set(0,0,0,'YXZ');
      invulnerableUntil = performance.now() + 1200;
      // start with two enemies
      respawnEnemies(2);
    }

    function openShopFromStart(){
      // close start screen and open the shop UI
      if(startScreenEl) startScreenEl.style.display = 'none';
      // force game-over-like state so shop can be opened cleanly
      paused = true;
      // show shop
      openShop();
      // ensure overlay remains hidden
      if(overlay) overlay.style.display = 'none';
    }

    // Arrow key handling for start screen
    window.addEventListener('keydown', function onStartKey(ev){
      if(!startScreenEl || startScreenEl.style.display === 'none') return;
      if(ev.code === 'ArrowLeft'){
        openShopFromStart();
        // consume event
        ev.preventDefault();
        ev.stopPropagation();
      } else if(ev.code === 'ArrowRight'){
        startGameFromStart();
        ev.preventDefault();
        ev.stopPropagation();
      }
    });
  }, 50);

  /* Upgrade & stats UI wiring */

 // helper to update the shop kills display when requested
 function updateShopKillsDisplay(){
   const el = document.getElementById('shopKills');
   if(el) el.textContent = String(totalKills || 0);
 }

 // Upgrade button handlers
 function closeUpgradeAndShowStats(){
   const up = document.getElementById('upgradeScreen');
   if(up) up.style.display = 'none';
   // show stats
   const ss = document.getElementById('statsScreen');
   if(ss){
     document.getElementById('statTotal').textContent = String(totalKills);
     document.getElementById('statWaveKills').textContent = String(killsThisWave);
     document.getElementById('statHigh').textContent = String(highScore);
     ss.style.display = 'flex';
   }
 }

 // finish stats and start next wave
function startNextWaveFromUI(){
  const ss = document.getElementById('statsScreen');
  if(ss) ss.style.display = 'none';
  awaitingUpgrade = false;
  // restore normal invulnerability behavior
  invulnerableUntil = performance.now() + 1200;
  // re-enable normal kill accounting when the next wave starts
  suppressKills = false;

  // apply any pending upgrades for the upcoming wave
  activeUpgrades = {
    slowMo: pendingUpgrades.slowMo,
    // jumpBoost can come from a pending purchase OR from a permanent purchase
    jumpBoost: pendingUpgrades.jumpBoost || permanentUpgrades.jumpBoost,
    autoFace: pendingUpgrades.autoFace
  };
  // clear pending (they are single-wave) -- permanentUpgrades remain untouched
  pendingUpgrades = { slowMo:false, jumpBoost:false, autoFace:false };

  // apply active upgrade effects
  timeScale = activeUpgrades.slowMo ? 0.625 : 1.0;
  jumpMultiplier = activeUpgrades.jumpBoost ? 1.5 : 1.0;
  autoFaceActive = !!activeUpgrades.autoFace;

  // increment the logical wave counter
  waveStage += 1;

  // Determine next wave by toggling the currentWaveType (avoid relying on previous parity state)
  // If we were in a normal wave, next should be cannon; if we were in a cannon wave, next should be normal.
  if(currentWaveType === 'normal'){
    currentWaveType = 'cannon';
    cannonActive = true;
    cannonWaveCount += 1;
    cannonKillsThisWave = 0;
    // On the 3rd cannon wave, reset current speed to base but do NOT increase spawn count.
    if(cannonWaveCount === 3){
      cannonCurrentSpeedMultiplier = 1.0;
      cannonCurrentSpeed = cannonSpeedBase * cannonCurrentSpeedMultiplier;
    }
    // always spawn a single cannonball per spawn; remove per-wave spawn escalation
    spawnNextCannonball(1);
  } else {
    currentWaveType = 'normal';
    cannonActive = false;
    respawnEnemies(2);
  }
}

respawnBtn.addEventListener('pointerdown', (e)=>{
  e.preventDefault();
  // close shop if open
  if(shopScreen) shopScreen.style.display = 'none';
  shopSelectedItem = null;
  if(shopSelectedLabel) shopSelectedLabel.textContent = 'None';

  lives = 3;
  isGameOver = false;
  overlay.style.display = 'none';
  camera.position.set(0,18,0);
  camera.rotation.set(0,0,0,'YXZ');
  // reset wave system state and ensure respawn uses exactly two enemies
  killCount = 0;
  if(typeof killsEl !== 'undefined' && killsEl) killsEl.textContent = `Kills: ${killCount}`;
  totalKills = 0;
  // clear persisted state on full restart
  try { localStorage.removeItem('fp_state'); } catch(e){}
  // update shop currency display after reset
  try { updateShopKillsDisplay(); } catch(e){}
  killsSinceWaveStart = 0;
  waveStage = 0;
  currentWaveType = 'normal';
  cannonActive = false;
  cannonCurrentSpeed = cannonSpeedBase;
  // ensure suppression is off when restarting
  suppressKills = false;
  respawnEnemies(2);
});

// Unpause button: resume game from pause overlay
const unpauseBtn = document.getElementById('unpauseBtn');
if(unpauseBtn){
  unpauseBtn.addEventListener('pointerdown', (e)=>{
    e.preventDefault();
    // Hide pause overlay and resume gameplay
    paused = false;
    overlay.style.display = 'none';
    // restore respawn button visibility and hide restartRound when unpausing
    try { respawnBtn.style.display = ''; } catch(e){}
    const restartBtn = document.getElementById('restartRoundBtn');
    if(restartBtn) restartBtn.style.display = 'none';
    // ensure player has a short grace period of invulnerability after unpausing
    invulnerableUntil = performance.now() + 1200;
  });
}

// Restart Round button in pause overlay: start a fresh round while paused (keeps behavior consistent)
const restartRoundBtn = document.getElementById('restartRoundBtn');
if(restartRoundBtn){
  restartRoundBtn.addEventListener('pointerdown', (e)=>{
    e.preventDefault();
    // use same restart behavior used for pause restart helper
    restartRoundFromPause();
    // hide overlay and ensure restart button hides
    overlay.style.display = 'none';
    restartRoundBtn.style.display = 'none';
  });
}

 // helper to restart the round when invoked from the pause menu (keeps lives intact)
 function restartRoundFromPause(){
   // unpause the game and hide overlay
   paused = false;
   overlay.style.display = 'none';
   respawnEnemies(2);
   // center the player in the arena at a visible height
   camera.position.set(0,18,0);
   camera.rotation.set(0,0,0,'YXZ');
   // ensure normal gameplay state
   suppressKills = false;
   invulnerableUntil = performance.now() + 1200;
 }

 // open shop button shown on overlay (when game over or pause)
 if(shopBtn){
   shopBtn.addEventListener('pointerdown', (e)=>{
     e.preventDefault();
     // If game is paused (Escape), provide a choice to the player:
     // - OK -> lose all lives and open the shop (trigger game-over flow)
     // - Cancel -> restart the round (respawn enemies, keep lives)
     if(paused){
       const choice = window.confirm('Open shop from pause? OK = lose all lives and open shop. Cancel = restart the round.');
       if(choice){
         // force player to lose all lives and trigger game-over overlay, then open shop
         lives = 0;
         // ensure UI reflects zero lives immediately
         if(fpsEl) fpsEl.textContent = `${Math.round(1/Math.max(clock.getDelta(),1e-6))} fps   ♥ ${lives}`;
         // trigger death handling which will show the overlay; use a reason string so overlay text is informative
         playerDie('entered shop from pause');
         // open shop UI once overlay/game-over state is set
         openShop();
       } else {
         // restart the round: unpause, reset player position and respawn enemies
         restartRoundFromPause();
       }
     } else {
       // normal behavior when not paused (e.g. from game-over overlay)
       openShop();
     }
   });
 }

// shop UI helpers
function openShop(){
  if(!shopScreen) return;
  shopScreen.style.display = 'flex';
  shopSelectedItem = null;
  if(shopSelectedLabel) shopSelectedLabel.textContent = 'None';
  // ensure currency display is current and code UI is reset
  try {
    updateShopKillsDisplay();
    const codeInput = document.getElementById('shopCode');
    const redeemBtn = document.getElementById('redeemCode');
    if(codeInput){ codeInput.value = ''; codeInput.disabled = false; }
    if(redeemBtn){ redeemBtn.disabled = false; redeemBtn.style.opacity = ''; redeemBtn.textContent = 'Redeem'; }
  } catch(e){}
}

function closeShop(){
  if(!shopScreen) return;
  shopScreen.style.display = 'none';
  shopSelectedItem = null;
  if(shopSelectedLabel) shopSelectedLabel.textContent = 'None';
}

// "Send all to Inventory" wiring: move every hotbar item into inventory, clear slots, update visuals & persist
const sendAllBtn = document.getElementById('sendAllToInv');
if(sendAllBtn){
  sendAllBtn.addEventListener('pointerdown',(e)=>{
    e.preventDefault();
    // iterate all hotbar slots and move any item into inventory
    document.querySelectorAll('.hotbar-slot').forEach(slot => {
      const id = slot.dataset.item || '';
      if(id && id !== ''){
        inventory.push(id);
        // clear the slot visually and in dataset
        slot.dataset.item = '';
        slot.classList.add('empty');
        const main = slot.querySelector('.shop-label');
        if(main) main.remove();
      }
    });
    // refresh inventory UI and hotbar visuals
    try { renderInventoryList(); } catch(e){}
    updateHotbarVisuals();
    // persist state
    try {
      const hotbar = [];
      document.querySelectorAll('.hotbar-slot').forEach((el)=> hotbar.push(el.dataset.item || ''));
      saveState({ totalKills, hotbar, permanentUpgrades, purchasedItems, inventory });
    } catch(e){}
  });
}

// basic shop item selection & equip flow
  // helper: allowed categories per specialized slot (4..7)
  function allowedSlotForItem(itemId, slotNum){
    if(!itemId) return false;
    const id = String(itemId).toLowerCase();
    const longRange = ['sniper_rifle','explosive_arrow','railgun','grappling_hook','tele_shot'];
    const shortRange = ['plasma_blade','stealth_sword','warhammer','sword'];
    const potions = ['regen_elixir','health_potion_shop','energy_tonic'];
    const handhelds = ['smoke_bomb','flashbang','handheld_1','handheld_2','handheld_3'];

    if(slotNum === 4) return longRange.includes(id) || id.includes('rifle') || id.includes('rail') || id.includes('explosive') || id.includes('grappl');
    if(slotNum === 5) return shortRange.includes(id) || id.includes('sword') || id.includes('blade') || id.includes('hammer');
    if(slotNum === 6) return potions.includes(id) || id.includes('potion') || id.includes('elixir') || id.includes('tonic');
    if(slotNum === 7) return handhelds.includes(id) || id.includes('bomb') || id.includes('flash') || id.includes('handheld');
    // default: allow any for slots 1..3 (slot3 is reserved for grenades but still accepts grenades)
    return slotNum >=1 && slotNum <=3;
  }

if(shopScreen){
  shopScreen.addEventListener('click', (ev)=>{
    const btn = ev.target.closest && ev.target.closest('.shop-item');
    if(btn && btn.dataset && btn.dataset.item){
      const itemId = btn.dataset.item;
      // cost table for shop items (only stealth_sword has a real cost for now)
      const cost = SHOP_COSTS[itemId] || 0;
      if(cost > 0){
        if(totalKills >= cost){
          totalKills -= cost;
          shopSelectedItem = itemId;
          if(shopSelectedLabel) shopSelectedLabel.textContent = shopSelectedItem;
          // Immediately add purchased item to inventory (except for the extra slot which is handled specially)
          // Handle permanent stackable upgrades separately so they do NOT go into inventory.
          if(itemId === 'speed_upgrade' || itemId === 'jump_upgrade' || itemId === 'cooldown_upgrade'){
            // deduct cost already done; increment counters and persist
            if(itemId === 'speed_upgrade'){
              permanentUpgrades.speedCount = (permanentUpgrades.speedCount || 0) + 1;
              // double the speed upgrade cost for subsequent purchases
              SHOP_COSTS.speed_upgrade = Math.max(1, Math.floor((SHOP_COSTS.speed_upgrade || 50) * 2));
              // update the shop button text if it exists so UI reflects new price
              try {
                const speedBtn = document.querySelector('.shop-item[data-item="speed_upgrade"]');
                if(speedBtn) speedBtn.textContent = `Speed Upgrade — ${SHOP_COSTS.speed_upgrade} kills`;
              } catch(e){}
            } else if(itemId === 'jump_upgrade'){
              permanentUpgrades.jumpCount = (permanentUpgrades.jumpCount || 0) + 1;
              // double the jump upgrade cost for subsequent purchases
              SHOP_COSTS.jump_upgrade = Math.max(1, Math.floor((SHOP_COSTS.jump_upgrade || 50) * 2));
              // update the shop button text if it exists so UI reflects new price
              try {
                const jumpBtn = document.querySelector('.shop-item[data-item="jump_upgrade"]');
                if(jumpBtn) jumpBtn.textContent = `Jump Upgrade — ${SHOP_COSTS.jump_upgrade} kills`;
              } catch(e){}
            } else if(itemId === 'cooldown_upgrade'){
              // increment cooldown purchase count and apply 0.25s (250ms) reduction per buy
              permanentUpgrades.cooldownCount = (permanentUpgrades.cooldownCount || 0) + 1;
              cooldownReduction = (permanentUpgrades.cooldownCount) * 250; // ms
              // multiply the cooldown upgrade cost by 4 for next purchase
              SHOP_COSTS.cooldown_upgrade = Math.max(1, Math.floor((SHOP_COSTS.cooldown_upgrade || 200) * 4));
              // update the shop button text if it exists so UI reflects new price
              try {
                const cdBtn = document.querySelector('.shop-item[data-item="cooldown_upgrade"]');
                if(cdBtn) cdBtn.textContent = `Cooldown Upgrade — ${SHOP_COSTS.cooldown_upgrade} kills`;
              } catch(e){}
            }
            // visual feedback and disable the button briefly (but allow repeat purchases)
            btn.style.outline = '2px solid rgba(40,200,120,0.28)';
            btn.style.opacity = '0.85';
            setTimeout(()=>{ btn.style.outline = ''; btn.style.opacity = ''; }, 420);
            // persist immediately (do not add to inventory)
            try {
              const hotbar = [];
              document.querySelectorAll('.hotbar-slot').forEach((el)=> hotbar.push(el.dataset.item || ''));
              saveState({ totalKills, hotbar, permanentUpgrades, purchasedItems, inventory });
            } catch(e){}
            // update shop display
            try { updateShopKillsDisplay(); } catch(e){}
            // no further handling needed for these purchases
          } else {
            if(itemId !== 'extra_slot'){
              inventory.push(itemId);
            }
            // mark as purchased to prevent re-buy where applicable
            purchasedItems[itemId] = true;
            // If extra hotbar slot bought, create it now
            if(itemId === 'extra_slot'){
              addExtraHotbarSlot();
              // provide immediate visual feedback on the shop button and disable it
              btn.disabled = true;
              btn.style.opacity = '0.55';
              btn.title = (btn.title ? btn.title + ' • Owned' : 'Owned');
            } else {
              // visual purchase feedback for normal items
              btn.style.outline = '2px solid rgba(40,200,120,0.6)';
              btn.style.opacity = '0.6';
              btn.disabled = true;
              setTimeout(()=>{ btn.style.outline = ''; }, 600);
            }
            // update shop currency display after purchase
            try { updateShopKillsDisplay(); } catch(e){}
            // refresh inventory UI if open
            try { renderInventoryList(); } catch(e){}
            // persist purchase, hotbar and inventory state
            try {
              const hotbar = [];
              document.querySelectorAll('.hotbar-slot').forEach((el)=> hotbar.push(el.dataset.item || ''));
              saveState({ totalKills, hotbar, permanentUpgrades, purchasedItems, inventory });
            } catch(e){}
          }
        } else {
          // not enough currency: brief flash
          btn.style.transform = 'scale(0.98)';
          setTimeout(()=>{ btn.style.transform = ''; }, 160);
        }
      } else {
        shopSelectedItem = itemId;
        if(shopSelectedLabel) shopSelectedLabel.textContent = shopSelectedItem;
        // visually indicate selection briefly
        btn.style.outline = '2px solid rgba(40,200,120,0.6)';
        setTimeout(()=>{ btn.style.outline = ''; }, 600);
      }
    }
    if(ev.target && ev.target.id === 'closeShop') closeShop();
    if(ev.target && ev.target.id === 'shopHelp'){
      // brief visual help: update text then revert
      const prev = shopSelectedLabel ? shopSelectedLabel.textContent : '';
      if(shopSelectedLabel) shopSelectedLabel.textContent = 'Select item, then click hotbar slot';
      setTimeout(()=>{ if(shopSelectedLabel) shopSelectedLabel.textContent = prev || 'None'; }, 1500);
    }
  });

  // Redeem code button handler (supports 'ineedkills' → +2000 kills)
  const redeemBtn = document.getElementById('redeemCode');
  const codeInput = document.getElementById('shopCode');
  if(redeemBtn && codeInput){
    redeemBtn.addEventListener('click', (e)=>{
      e.preventDefault();
      const code = (codeInput.value || '').trim().toLowerCase();
      if(!code) {
        codeInput.style.transform = 'scale(0.98)';
        setTimeout(()=>{ codeInput.style.transform = ''; }, 120);
        return;
      }
      if(code === 'ineedkills'){
        totalKills = (totalKills || 0) + 10000;
        // disable the input after successful redeem to prevent repeat use
        codeInput.value = '';
        codeInput.disabled = true;
        redeemBtn.disabled = true;
        redeemBtn.style.opacity = '0.5';
        // visual confirmation
        redeemBtn.textContent = 'Redeemed';
        // update shop currency display
        try { updateShopKillsDisplay(); } catch(e){}
        // persist redeemed currency
        try {
          const hotbar = [];
          document.querySelectorAll('.hotbar-slot').forEach((el)=> hotbar.push(el.dataset.item || ''));
          saveState({ totalKills, hotbar, permanentUpgrades, purchasedItems, inventory });
        } catch(e){}
      } else {
        // invalid code feedback
        codeInput.style.transform = 'translateY(-3px)';
        setTimeout(()=>{ codeInput.style.transform = ''; }, 160);
      }
    });
  }

  // Info button handler for shop items (delegated): show a brief description for any .shop-info clicked
  (function(){
    const shopRoot = document.getElementById('shopScreen');
    if(!shopRoot) return;
    shopRoot.addEventListener('click', (ev)=>{
      const infoBtn = ev.target.closest && ev.target.closest('.shop-info');
      if(!infoBtn) return;
      const info = infoBtn.dataset.info || infoBtn.title || 'No description available.';
      // simple modal/alert to show info
      try {
        // prefer a small, styled in-page tooltip via alert fallback for simplicity
        alert(info);
      } catch(e){
        console.log('Item info:', info);
      }
    });
  })();
}

// Inventory UI helpers
function renderInventoryList(){
  const listWrap = document.getElementById('inventoryList');
  const invCount = document.getElementById('invCount');
  if(!listWrap) return;
  listWrap.innerHTML = '';
  if(invCount) invCount.textContent = String(inventory.length);
  if(inventory.length === 0){
    const none = document.createElement('div');
    none.style.color = '#ddd';
    none.textContent = 'Inventory is empty';
    listWrap.appendChild(none);
    return;
  }
  // show each inventory item with actions
  inventory.forEach((id, idx) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.justifyContent = 'space-between';
    row.style.gap = '8px';
    row.style.padding = '8px';
    row.style.borderRadius = '8px';
    row.style.background = 'rgba(255,255,255,0.02)';
    const label = document.createElement('div');
    label.style.fontWeight = '700';
    label.style.color = '#ffd';
    label.textContent = id.replace('_',' ');
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    const placeBtn = document.createElement('button');
    placeBtn.textContent = 'Place';
    placeBtn.style.padding = '6px 8px';
    placeBtn.style.borderRadius = '8px';
    placeBtn.style.border = '0';
    placeBtn.style.background = '#28a745';
    placeBtn.style.color = '#fff';
    placeBtn.addEventListener('click', ()=> {
      // ask which slot to place into
      const s = prompt('Place into slot number (1-6). Slot 3 reserved for grenades; choose another slot to swap.');
      const slotNum = Number(s);
      if(!slotNum || isNaN(slotNum) || slotNum < 1 || slotNum > 6){ alert('Invalid slot'); return; }
      if(slotNum === 3){ alert('Slot 3 is reserved and cannot be swapped into.'); return; }
      const slotEl = document.querySelector(`.hotbar-slot[data-slot="${slotNum}"]`);
      if(!slotEl) return;
      // if slot occupied, move existing into inventory
      const prev = slotEl.dataset.item || '';
      if(prev && prev !== ''){
        inventory.push(prev);
      }
      // place this inventory item into the slot
      slotEl.classList.remove('empty');
      slotEl.dataset.item = id;
      let main = slotEl.querySelector('.shop-label');
      if(!main){
        main = document.createElement('div');
        main.className = 'shop-label';
        main.style.fontWeight = '800';
        main.style.fontSize = '12px';
        slotEl.insertBefore(main, slotEl.querySelector('.slot-label'));
      }
      main.textContent = id.replace('_',' ');
      // remove item from inventory array
      inventory.splice(idx,1);
      // persist
      try {
        const hotbar = [];
        document.querySelectorAll('.hotbar-slot').forEach((el)=> hotbar.push(el.dataset.item || ''));
        saveState({ totalKills, hotbar, permanentUpgrades, purchasedItems, inventory });
      } catch(e){}
      // update UI
      renderInventoryList();
      updateHotbarVisuals();
    });
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Drop';
    removeBtn.style.padding = '6px 8px';
    removeBtn.style.borderRadius = '8px';
    removeBtn.style.border = '0';
    removeBtn.style.background = '#c0392b';
    removeBtn.style.color = '#fff';
    removeBtn.addEventListener('click', ()=>{
      if(!confirm('Remove this item from inventory?')) return;
      inventory.splice(idx,1);
      try {
        const hotbar = [];
        document.querySelectorAll('.hotbar-slot').forEach((el)=> hotbar.push(el.dataset.item || ''));
        saveState({ totalKills, hotbar, permanentUpgrades, purchasedItems, inventory });
      } catch(e){}
      renderInventoryList();
    });
    actions.appendChild(placeBtn);
    actions.appendChild(removeBtn);
    row.appendChild(label);
    row.appendChild(actions);
    listWrap.appendChild(row);
  });
}

// Inventory panel open/close wiring
const openInvBtn = document.getElementById('openInventory');
const invPanel = document.getElementById('inventoryPanel');
const closeInvBtn = document.getElementById('closeInventory');
if(openInvBtn && invPanel){
  openInvBtn.addEventListener('pointerdown', (e)=>{
    e.preventDefault();
    invPanel.style.display = 'flex';
    renderInventoryList();
  });
}
if(closeInvBtn && invPanel){
  closeInvBtn.addEventListener('pointerdown', (e)=>{
    e.preventDefault();
    invPanel.style.display = 'none';
  });
}

  // while the shop is open, allow clicking a hotbar slot to equip the chosen (placeholder) item
document.addEventListener('click', (ev)=>{
  // if shop not open do nothing here (other handlers exist elsewhere)
  if(!shopScreen || shopScreen.style.display !== 'flex') return;
  const slot = ev.target.closest && ev.target.closest('.hotbar-slot');
  if(!slot || !slot.dataset || !slot.dataset.slot) return;
  const slotNum = Number(slot.dataset.slot);

  // must have an item selected
  if(!shopSelectedItem) {
    // brief flash to indicate no item chosen
    slot.style.transform = 'scale(0.98)';
    setTimeout(()=>{ slot.style.transform = ''; }, 140);
    return;
  }

  // Validate allowed categories for specialized slots (4..7)
  if(slotNum >= 4 && slotNum <= 7){
    if(!allowedSlotForItem(shopSelectedItem, slotNum)){
      // rejection feedback
      slot.style.transform = 'scale(0.94)';
      setTimeout(()=>{ slot.style.transform = ''; }, 160);
      alert('This slot only accepts specific item types.');
      return;
    }
  }

  // If slot is occupied, move the existing item to inventory.
  const prevItem = slot.dataset.item || '';
  if(prevItem && prevItem !== ''){
    // slot 3 is reserved for grenades; replacing it is not allowed.
    if(slot.dataset.slot === '3'){
      // If the player attempted to place here by mistake, move the selected item into inventory
      // instead of letting it disappear. Provide brief feedback and persist state.
      if(shopSelectedItem){
        inventory.push(shopSelectedItem);
        // clear the selection so UI matches state
        shopSelectedItem = null;
        if(shopSelectedLabel) shopSelectedLabel.textContent = 'None';
        // visual feedback
        slot.style.transform = 'scale(0.96)';
        setTimeout(()=>{ slot.style.transform = ''; }, 160);
        // persist state
        try {
          const hotbar = [];
          document.querySelectorAll('.hotbar-slot').forEach((el)=> hotbar.push(el.dataset.item || ''));
          saveState({ totalKills, hotbar, permanentUpgrades, purchasedItems, inventory });
        } catch(e){}
        // close the shop to avoid confusion
        closeShop();
      } else {
        // no selected item — just provide a nudge feedback
        slot.style.transform = 'scale(0.98)';
        setTimeout(()=>{ slot.style.transform = ''; }, 140);
      }
      return;
    } else {
      inventory.push(prevItem);
    }
  }

  // assign the chosen placeholder item into the slot dataset and update visible label
  slot.classList.remove('empty');
  slot.dataset.item = shopSelectedItem;
  // insert or update a small label showing the item id
  let main = slot.querySelector('.shop-label');
  if(!main){
    main = document.createElement('div');
    main.className = 'shop-label';
    main.style.fontWeight = '800';
    main.style.fontSize = '12px';
    slot.insertBefore(main, slot.querySelector('.slot-label'));
  }
  main.textContent = shopSelectedItem.replace('_', ' ');

  // persist hotbar and inventory assignment immediately
  try {
    const hotbar = [];
    document.querySelectorAll('.hotbar-slot').forEach((el)=> hotbar.push(el.dataset.item || ''));
    saveState({ totalKills, hotbar, permanentUpgrades, purchasedItems, inventory });
  } catch(e){}

  // close shop automatically after equipping
  closeShop();
  // refresh hotbar visuals so selection state persists visually
  updateHotbarVisuals();
  // update shop display (in case currency changed elsewhere)
  try { updateShopKillsDisplay(); } catch(e){}
});

 // upgrade UI interactions
document.addEventListener('click', (ev)=>{
  const target = ev.target;
  if(!target) return;
  // purchase button
  if(target.classList && target.classList.contains('upgradeBtn')){
    const cost = Number(target.dataset.cost) || 1;
    // purchases use totalKills as the currency rather than lives
    if(totalKills >= cost){
      totalKills = Math.max(0, totalKills - cost);
      // simple placeholder effect: mark as purchased (disable)
      target.disabled = true;
      target.style.opacity = '0.55';
      // if button specifies an upgrade, mark it as pending for the next wave
      const upKey = target.dataset.upgrade;
      if(upKey === 'slowMo') pendingUpgrades.slowMo = true;
      if(upKey === 'jumpBoost') {
        // jump boost should persist: mark permanent and also pending so it takes effect next wave
        permanentUpgrades.jumpBoost = true;
        pendingUpgrades.jumpBoost = true;
        // persist permanent upgrade
        try {
          const hotbar = [];
          document.querySelectorAll('.hotbar-slot').forEach((el)=> hotbar.push(el.dataset.item || ''));
          saveState({ totalKills, hotbar, permanentUpgrades });
        } catch(e){}
      }
      if(upKey === 'autoFace') pendingUpgrades.autoFace = true;
      // update currency display in the upgrade UI
      const upLives = document.getElementById('upgradeLives');
      if(upLives) upLives.textContent = String(totalKills);
    } else {
      // insufficient currency: brief flash
      target.style.transform = 'scale(0.98)';
      setTimeout(()=>{ target.style.transform = ''; }, 160);
    }
  }

  // skip upgrades
  if(target.id === 'skipUpgrades'){
    closeUpgradeAndShowStats();
  }
  // finish upgrades (continue to stats)
  if(target.id === 'finishUpgrades'){
    closeUpgradeAndShowStats();
  }

  // next wave button on stats screen
  if(target.id === 'nextWaveBtn'){
    startNextWaveFromUI();
  }
});