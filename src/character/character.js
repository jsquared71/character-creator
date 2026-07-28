import * as THREE from 'three';
import { buildBodyGeometry } from './body.js';
import { buildHairGeometry } from './hair.js';
import { buildArmorSet } from './armor.js';
import { createSkinMaterial } from '../materials/skin.js';
import { createHairMaterial } from '../materials/hair.js';
import { createArmorMaterial } from '../materials/armor.js';
import { createEyeMaterial } from '../materials/eye.js';

/**
 * Assembles the body, hair, armor and eyes into one group and owns the
 * rebuild/update split: geometry changes rebuild meshes, colour changes only
 * push uniforms. Nothing here allocates per frame.
 */
export class Character {
  constructor(ctx) {
    this.ctx = ctx; // { bakery, renderer, envMap }
    this.group = new THREE.Group();
    this.bodyGroup = new THREE.Group();
    this.group.add(this.bodyGroup);

    this.materials = {
      skin: createSkinMaterial(ctx, {}),
      hair: createHairMaterial(ctx, {}),
      armor: createArmorMaterial(ctx, {}),
      eye: createEyeMaterial(ctx, {})
    };

    this.meshes = {};
    this.joints = null;
    this.height = 1.85;
    this._disposables = [];
  }

  setEnvMap(envMap) {
    this.ctx.envMap = envMap;
    for (const m of Object.values(this.materials)) {
      if (m.userData.setEnvMap) m.userData.setEnvMap(envMap);
      else if ('envMap' in m) m.envMap = envMap;
      m.needsUpdate = true;
    }
  }

  /** Full rebuild — geometry-affecting state changed. */
  rebuild(resolved) {
    this._clear();

    const { build, features, race, klass, state } = resolved;
    this.height = build.height;

    const body = buildBodyGeometry(build, features, { faceIndex: state.faceIndex });
    this.joints = body.joints;

    const skin = new THREE.Mesh(body.geometry, this.materials.skin);
    skin.castShadow = true;
    skin.receiveShadow = true;
    this.bodyGroup.add(skin);
    this.meshes.body = skin;
    this._disposables.push(body.geometry);

    // Eyes ride the joint frame the head build reported.
    if (body.joints.eyes?.length) {
      const eyeGeo = new THREE.SphereGeometry(1, 20, 16);
      this._disposables.push(eyeGeo);
      const eyes = new THREE.InstancedMesh(eyeGeo, this.materials.eye, body.joints.eyes.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      body.joints.eyes.forEach((e, i) => {
        q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), e.forward);
        m.compose(e.position, q, new THREE.Vector3(e.radius, e.radius, e.radius));
        eyes.setMatrixAt(i, m);
      });
      eyes.instanceMatrix.needsUpdate = true;
      eyes.castShadow = false;
      this.bodyGroup.add(eyes);
      this.meshes.eyes = eyes;
    }

    const hair = buildHairGeometry(race, features, body.joints, {
      styleIndex: state.hairIndex,
      material: this.materials.hair
    });
    if (hair) {
      hair.castShadow = true;
      this.bodyGroup.add(hair);
      this.meshes.hair = hair;
      if (hair.geometry) this._disposables.push(hair.geometry);
    }

    const armor = buildArmorSet(klass, race, body.joints, build, {
      material: this.materials.armor,
      pauldrons: state.pauldrons,
      cape: state.cape
    });
    if (armor) {
      armor.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.bodyGroup.add(armor);
      this.meshes.armor = armor;
      armor.traverse((o) => { if (o.geometry) this._disposables.push(o.geometry); });
    }

    this.updateMaterials(resolved);
  }

  /** Cheap path — colours, tints, emissive. No allocation, no geometry work. */
  updateMaterials(resolved) {
    const { race, klass, state } = resolved;
    this.materials.skin.userData.update?.({
      tone: state.skin, race: race.name, features: resolved.features
    });
    this.materials.hair.userData.update?.({ color: state.hair, race: race.name });
    this.materials.eye.userData.update?.({ color: state.eyes });
    this.materials.armor.userData.update?.({
      klass, tier: klass.armor.tier, tint: klass.color
    });
  }

  tick(t, dt) {
    this.materials.skin.userData.tick?.(t, dt);
    this.materials.armor.userData.tick?.(t, dt);
    this.materials.hair.userData.tick?.(t, dt);
    this.materials.eye.userData.tick?.(t, dt);
  }

  _clear() {
    this.bodyGroup.clear();
    for (const g of this._disposables) g.dispose?.();
    this._disposables.length = 0;
    this.meshes = {};
  }
}
