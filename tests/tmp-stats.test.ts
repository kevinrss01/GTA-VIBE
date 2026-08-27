/** TEMPORARY diagnostic. Delete before finishing. */
import { describe, it } from 'vitest';
import type { BufferGeometry, Matrix4 } from 'three';

import type { MaterialKey } from '../src/render/materials';
import { getCityPlan } from '../src/world/CityPlan';
import { buildBuilding } from '../src/world/build/BuildingFactory';
import type {
  ColliderBox,
  GeometrySink,
  InteractionPoint,
  LightRequest,
  PropKey,
} from '../src/world/build/types';

class Sink implements GeometrySink {
  readonly geometries: { key: MaterialKey; geometry: BufferGeometry }[] = [];
  readonly instances: { prop: PropKey; matrix: Matrix4 }[] = [];
  readonly colliders: ColliderBox[] = [];
  readonly lights: LightRequest[] = [];
  readonly interactions: InteractionPoint[] = [];
  add(key: MaterialKey, geometry: BufferGeometry): void {
    this.geometries.push({ key, geometry });
  }
  instance(prop: PropKey, matrix: Matrix4): void {
    this.instances.push({ prop, matrix });
  }
  collider(box: ColliderBox): void {
    this.colliders.push(box);
  }
  light(request: LightRequest): void {
    this.lights.push(request);
  }
  interaction(point: InteractionPoint): void {
    this.interactions.push(point);
  }
  get triangles(): number {
    let total = 0;
    for (const entry of this.geometries) {
      const index = entry.geometry.getIndex();
      total += index ? index.count / 3 : entry.geometry.getAttribute('position').count / 3;
    }
    return total;
  }
}

describe('stats', () => {
  it('reports', () => {
    const plan = getCityPlan();
    const rows = plan.parcels.map((parcel) => {
      const sink = new Sink();
      buildBuilding(parcel, sink);
      return { parcel, tris: sink.triangles };
    });
    const total = rows.reduce((a, r) => a + r.tris, 0);
    const byDistrict = new Map<string, number[]>();
    const byArchetype = new Map<string, number[]>();
    for (const r of rows) {
      (byDistrict.get(r.parcel.district) ?? byDistrict.set(r.parcel.district, []).get(r.parcel.district)!).push(r.tris);
      (byArchetype.get(r.parcel.archetype) ?? byArchetype.set(r.parcel.archetype, []).get(r.parcel.archetype)!).push(r.tris);
    }
    const fmt = (m: Map<string, number[]>): string =>
      [...m.entries()]
        .map(([k, v]) => {
          const sum = v.reduce((a, c) => a + c, 0);
          return `${k}: n=${v.length} mean=${Math.round(sum / v.length)} max=${Math.max(...v)} sum=${sum}`;
        })
        .sort()
        .join('\n  ');
    console.log(`\nTOTAL ${total} over ${rows.length} buildings, mean ${Math.round(total / rows.length)}, max ${Math.max(...rows.map((r) => r.tris))}`);
    console.log(`BY DISTRICT\n  ${fmt(byDistrict)}`);
    console.log(`BY ARCHETYPE\n  ${fmt(byArchetype)}`);

    // Harbourside detail: rooflines along the promenade.
    const harbour = rows.filter((r) => r.parcel.district === 'harbourside');
    console.log(`\nHARBOURSIDE ${harbour.length} buildings`);
    const byBlock = new Map<string, typeof harbour>();
    for (const r of harbour) {
      const list = byBlock.get(r.parcel.blockId) ?? [];
      list.push(r);
      byBlock.set(r.parcel.blockId, list);
    }
    for (const [blockId, list] of [...byBlock.entries()].sort()) {
      const desc = list
        .slice()
        .sort((a, b) => a.parcel.rect.minZ - b.parcel.rect.minZ)
        .map((r) => {
          const roofY = r.parcel.groundY + r.parcel.groundStoreyHeight + (r.parcel.storeys - 1) * r.parcel.storeyHeight;
          return `${r.parcel.archetype.slice(0, 5)}/${r.parcel.facing[0]}/s${r.parcel.storeys}/h${roofY.toFixed(1)}/w${(r.parcel.rect.maxX - r.parcel.rect.minX).toFixed(1)}x${(r.parcel.rect.maxZ - r.parcel.rect.minZ).toFixed(1)}/t${r.tris}`;
        })
        .join('  ');
      console.log(`  ${blockId}: ${desc}`);
    }

    // Which harbourside buildings actually front the promenade (facing west)?
    const westFront = harbour.filter((r) => r.parcel.facing === 'west');
    console.log(`\nWEST-FACING HARBOURSIDE: ${westFront.length}`);
    for (const r of westFront.slice().sort((a, b) => a.parcel.rect.minZ - b.parcel.rect.minZ)) {
      const roofY = r.parcel.groundY + r.parcel.groundStoreyHeight + (r.parcel.storeys - 1) * r.parcel.storeyHeight;
      console.log(
        `  ${r.parcel.id} ${r.parcel.archetype} z=${r.parcel.rect.minZ.toFixed(1)}..${r.parcel.rect.maxZ.toFixed(1)} x=${r.parcel.rect.minX.toFixed(1)}..${r.parcel.rect.maxX.toFixed(1)} storeys=${r.parcel.storeys} roofY=${roofY.toFixed(2)} tris=${r.tris}`,
      );
    }
  });
});
