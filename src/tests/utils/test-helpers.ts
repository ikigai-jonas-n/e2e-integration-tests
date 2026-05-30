import { atLeast } from './version-gate';

// Kafka propagation (billing → bridge → Redis → game node) requires bridge to
// correctly process billing's game-update messages.
// bridge >= 1.8.0 added strict schema validation that rejects billing 1.7.x messages.
export const kafkaCompatible = atLeast('billing', '1.8.0') && atLeast('bridge', '1.8.0');
export const skipSlowKafka =  !kafkaCompatible;
