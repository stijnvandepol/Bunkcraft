import type { Mob } from '../Mob';
import {
  BreedGoal, CreeperSwellGoal, EatGrassGoal, FleeSunGoal, FloatGoal, FollowParentGoal, LeapAtTargetGoal, LookAtPlayerGoal,
  LoveFxGoal, MeleeAttackGoal, NearestPlayerTargetGoal, PanicGoal, RandomLookGoal, RangedAttackGoal, StrollGoal, TemptGoal,
} from './goals';
import {
  AvoidMobGoal, DrownedSwimGoal, EndermanStareGoal, FollowOwnerGoal, HorseRiddenGoal, LayEggGoal, OwnerHurtByTargetGoal,
  OwnerHurtTargetGoal, PotionAttackGoal, PreyTargetGoal, RetaliateGoal, SitGoal, SlimeHopGoal, TeleportGoal,
} from './specials';

/**
 * Goal lists per kind, in the priority order of the Minecraft Java 1.21 classes (lower number wins). Called once,
 * lazily on the mob's first tick (mirrors of server mobs never tick, so they never build a brain).
 */
export function setupBrain(m: Mob): void {
  const g = m.goals, t = m.targetGoals;
  const animal = (temptMod: number, panic = true): void => {
    g.add(0, new FloatGoal(m));
    if (panic) g.add(1, new PanicGoal(m));
    g.add(2, new BreedGoal(m));
    g.add(3, new TemptGoal(m, temptMod));
    g.add(4, new FollowParentGoal(m));
    g.add(6, new StrollGoal(m));
    g.add(7, new LookAtPlayerGoal(m));
    g.add(8, new RandomLookGoal(m));
    g.add(9, new LoveFxGoal(m));
  };
  const monster = (range: number): void => {
    g.add(0, new FloatGoal(m));
    g.add(7, new StrollGoal(m));
    g.add(8, new LookAtPlayerGoal(m, 8));
    g.add(9, new RandomLookGoal(m));
    t.add(2, new NearestPlayerTargetGoal(m, range, !!m.type.neutralInLight));
  };
  switch (m.type.kind) {
    case 'pig': animal(1.2); break;
    case 'cow': animal(1.25); break;
    case 'sheep': animal(1.1); g.add(5, new EatGrassGoal(m)); break;
    case 'chicken': animal(1.0); g.add(10, new LayEggGoal(m)); break;
    case 'horse':
      g.add(0, new HorseRiddenGoal(m));
      animal(1.25);
      break;
    case 'zombie':
    case 'husk':
      monster(32);
      g.add(2, new MeleeAttackGoal(m));
      break;
    case 'drowned':
      monster(32);
      g.add(1, new DrownedSwimGoal(m));
      g.add(2, new MeleeAttackGoal(m));
      break;
    case 'creeper':
      monster(16);
      g.add(1, new CreeperSwellGoal(m));
      g.add(4, new MeleeAttackGoal(m));
      break;
    case 'skeleton':
    case 'stray':
      monster(16);
      g.add(2, new FleeSunGoal(m));
      g.add(3, new AvoidMobGoal(m, ['wolf']));
      g.add(4, new RangedAttackGoal(m));
      break;
    case 'spider':
    case 'cave_spider':
      monster(32);
      g.add(3, new LeapAtTargetGoal(m));
      g.add(4, new MeleeAttackGoal(m));
      break;
    case 'witch':
      monster(16);
      g.add(2, new PotionAttackGoal(m));
      break;
    case 'slime':
      g.add(1, new SlimeHopGoal(m));
      t.add(2, new NearestPlayerTargetGoal(m, 16));
      break;
    case 'enderman':
      g.add(0, new FloatGoal(m));
      g.add(1, new TeleportGoal(m));
      g.add(2, new MeleeAttackGoal(m));
      g.add(7, new StrollGoal(m));
      g.add(8, new LookAtPlayerGoal(m, 8));
      g.add(9, new RandomLookGoal(m));
      t.add(1, new EndermanStareGoal(m));
      break;
    case 'wolf':
      g.add(1, new FloatGoal(m));
      g.add(2, new SitGoal(m));
      g.add(4, new LeapAtTargetGoal(m));
      g.add(5, new MeleeAttackGoal(m));
      g.add(6, new FollowOwnerGoal(m));
      g.add(7, new BreedGoal(m));
      g.add(8, new StrollGoal(m));
      g.add(10, new LookAtPlayerGoal(m, 8));
      g.add(10, new RandomLookGoal(m));
      g.add(11, new LoveFxGoal(m));
      g.add(12, new FollowParentGoal(m));
      t.add(1, new OwnerHurtByTargetGoal(m));
      t.add(2, new OwnerHurtTargetGoal(m));
      t.add(3, new RetaliateGoal(m));
      t.add(5, new PreyTargetGoal(m, ['skeleton', 'stray'], false, 0.1));
      t.add(6, new PreyTargetGoal(m, ['sheep'], true, 0.01));
      break;
    default:
      break;
  }
}
