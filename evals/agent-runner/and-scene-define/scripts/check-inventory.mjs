#!/usr/bin/env node
import { assertPinnedInventory } from '../lib/inventory.mjs'
await assertPinnedInventory()
console.log('Inventory, reference snapshot, and versioned inputs are pinned and current.')
