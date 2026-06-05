import * as THREE from 'three';
import nipplejs from 'nipplejs';

export function createControls(opts = {}){
  const camera = opts.camera;
  const dom = opts.domElement || document.body;
  const onFire = opts.onFire || (()=>{});

  let pitch = 0; // vertical rotation in radians
  let yaw = 0;   // horizontal rotation
  const lookSensitivity = 0.0025;
  const maxPitch = Math.PI/2 - 0.05; // clamp

  let moveX = 0;
  let moveZ = 0;

  let pointerLocked = false;
  let enablePointerLock = (document.pointerLockElement !== undefined);

  // Desktop: pointer movement and WASD
  function onPointerMove(e){
    if(pointerLocked){
      yaw -= e.movementX * lookSensitivity;
      pitch -= e.movementY * lookSensitivity;
      clampAndApply();
    }
  }
  function clampAndApply(){
    pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
    // apply rotations to camera
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  function requestPointerLock(){
    dom.requestPointerLock();
  }

  document.addEventListener('pointerlockchange', ()=>{
    pointerLocked = (document.pointerLockElement === dom);
  });

  document.addEventListener('mousemove', onPointerMove);

  // keyboard
  const keys = {};
  window.addEventListener('keydown', (e)=>{
    keys[e.code] = true;
  });
  window.addEventListener('keyup', (e)=>{
    keys[e.code] = false;
  });

  // mobile: nipplejs for movement and touch look
  let mobileLookActive = false;
  let lookTouchId = null;
  let lastTouch = null;

  // create joystick
  const joyWrap = document.getElementById('joyWrap');
  const manager = nipplejs.create({
    zone: joyWrap,
    mode: 'static',
    position: {left:'70px', top:'70px'},
    color: '#ffffff66',
    size: 120
  });

  manager.on('move', (evt, data)=>{
    if(data && data.vector){
      // data.vector.x: -1..1 left/right, y: -1..1 up/down
      moveX = data.vector.x;
      moveZ = -data.vector.y; // forward is negative y from joystick
    }
  });
  manager.on('end', ()=>{ moveX = 0; moveZ = 0; });

  // mobile look: two-finger drag on right half for look
  dom.addEventListener('touchstart', (e)=>{
    if(e.touches.length >= 2){
      mobileLookActive = true;
      lookTouchId = e.touches[1].identifier;
      lastTouch = getTouchById(e.touches, lookTouchId);
    }
  }, {passive:true});
  dom.addEventListener('touchmove', (e)=>{
    if(mobileLookActive){
      const t = getTouchById(e.touches, lookTouchId);
      if(t && lastTouch){
        const dx = t.clientX - lastTouch.clientX;
        const dy = t.clientY - lastTouch.clientY;
        yaw -= dx * lookSensitivity;
        pitch -= dy * lookSensitivity;
        clampAndApply();
        lastTouch = t;
      }
    }
  }, {passive:true});
  dom.addEventListener('touchend', (e)=>{
    if(mobileLookActive){
      const t = getTouchById(e.touches, lookTouchId);
      if(!t){ mobileLookActive = false; lookTouchId = null; lastTouch = null; }
    }
  });

  function getTouchById(list, id){
    for(let i=0;i<list.length;i++) if(list[i].identifier === id) return list[i];
    return null;
  }

  // mouse click to fire on desktop
  dom.addEventListener('pointerdown', (e)=>{
    if(!pointerLocked) return;
    onFire();
  });

  function getMovementVector(){
    // derive movement from keys and joystick
    let x = 0, z = 0;
    // WASD / ArrowKeys
    if(keys['KeyW'] || keys['ArrowUp']) z -= 1;
    if(keys['KeyS'] || keys['ArrowDown']) z += 1;
    if(keys['KeyA'] || keys['ArrowLeft']) x -= 1;
    if(keys['KeyD'] || keys['ArrowRight']) x += 1;

    // combine with mobile joystick (gives finer control)
    if(Math.abs(moveX) > 0.01) x += moveX;
    if(Math.abs(moveZ) > 0.01) z += moveZ;

    // normalize to avoid faster diagonal speed
    const len = Math.hypot(x,z);
    if(len > 1) { x /= len; z /= len; }

    // include jump (Space) state
    const jump = !!keys['Space'];

    return {x, z, lookY: yaw, jump};
  }

  return {
    getMovementVector,
    enablePointerLock,
    requestPointerLock,
    // expose a function so callers get the live pointer-locked state
    isPointerLocked: () => pointerLocked
  };
}