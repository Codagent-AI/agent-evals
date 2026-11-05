#!/usr/bin/env node
import { assertPinnedInventory } from '../../../lib/define-run/inventory.mjs'
await assertPinnedInventory()
console.log('Inventory, reference snapshot, and versioned inputs are pinned and current.')
