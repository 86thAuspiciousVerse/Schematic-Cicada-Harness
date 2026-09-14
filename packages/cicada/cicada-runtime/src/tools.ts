/**
 * The eight producer write tools (4-spec §5.2 / 8-spec §2–§9): registry-ready
 * `defineTool` definitions whose bodies run against the turn-local model
 * through a {@link CicadaToolHost}. This file is the tool-schema single
 * authority (AGENTS 铁律 5).
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SemanticModel } from '@deepseek-ai/dsh-cicada-deriver'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { Model } from './file-model.ts'
import {
  connectPins,
  disconnect,
  placeLabel,
  placeNoConnect,
  placePowerSymbol,
  placeSymbol,
  removeComponent,
  setProperty,
  type ConnectPinsArgs,
  type DisconnectArgs,
  type OpHost,
  type PlaceLabelArgs,
  type PlacePowerArgs,
  type PlaceSymbolArgs,
  type RemoveComponentArgs,
  type SetPropertyArgs,
} from './ops.ts'

/** Runtime entry point backing every tool body. */
export interface CicadaToolHost {
  /** Run one op inside the calling agent's turn transaction (recorded in the oplog). */
  perform<T>(agent: Agent | undefined, record: { tool: string; args: unknown }, op: (model: Model) => T): Promise<T>
}

/** Read-only host: evaluates ops against the current semantic view. */
export interface CicadaReadHost {
  perform<T>(agent: Agent | undefined, record: { tool: string; args: unknown }, op: (view: SemanticModel) => T): Promise<T>
}

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

/**
 * Net view returned by `place_label` / `place_power_symbol`. Declaring it as an
 * empty object with `additionalProperties: false` rejected every successful
 * call, so the caller saw a schema error for a write that had already landed
 * (probes 4 and 5 both hit it).
 */
const NET_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    members: { type: 'array', items: { type: 'string' } },
  },
} as const

function resultOf<T>(value: T, message: string): { ok: true; message: string } & T {
  return { ok: true as const, message, ...value }
}

/** Build all eight write tools bound to a runtime host. */
export function cicadaWriteTools(host: CicadaToolHost, opHost: OpHost): ToolDefinition[] {
  return [
    defineTool({
      name: 'place_symbol',
      description: 'Place a new component symbol (library, template or datasheet IC) on the schematic. '
        + 'Library lane: lib_id is an exact key from list_library_symbols (category:name, e.g. R:R, '
        + 'C:C, POWER:GND, IC:AMS1117); a key the catalog does not list yet is resolved from the '
        + 'workspace shape block and synthesized into the user library. Template lane: kind + optional '
        + 'footprint. Datasheet lane: exact part_number + package, source_ids selects datasheet detail '
        + 'groups. Coordinates are always system-assigned. The result carries pin_table keyed by '
        + 'physical pin number — use those numbers as endpoint tokens.',
      parameters: {
        refdes: { type: 'string', required: true, description: 'Unique reference designator, e.g. R1, U2.' },
        value: { type: 'string', required: true, description: 'Component value, e.g. 10k, STM32C011J4M6.' },
        lib_id: { type: 'string', description: 'Library lane: exact library key from list_library_symbols (category:name, e.g. R:R, IC:AMS1117).' },
        source_ids: {
          type: 'array',
          items: { type: 'string' },
          // Required for the datasheet lane only; the library and template lanes
          // place without it (probe 6: a required flag here made the producer
          // retry with an empty array).
          description: 'Datasheet lane: the detail group ids anchoring this placement (`detail/<group>.json`). Omit for the library and template lanes.',
        },
        part_number: { type: 'string', description: 'Exact part number for the datasheet lane.' },
        package: { type: 'string', description: 'Package / footprint text (datasheet lane).' },
        kind: { type: 'string', enum: ['sym2', 'polar2', 'tri', 'connector', 'power'], description: 'Template kind (template lane).' },
        footprint: { type: 'string', description: 'Footprint text (template lane).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            refdes: { type: 'string' },
            lib_id: { type: 'string' },
            pin_table: { type: 'object', additionalProperties: true, properties: {} },
          },
        },
        render: (_args, value) => text(JSON.stringify(value, null, 1)),
      },
      async execute(args: PlaceSymbolArgs, exec) {
        const result = await host.perform(exec.agent, { tool: 'place_symbol', args }, (model) => placeSymbol(model, args, opHost))
        return resultOf(result, `已放置 ${args.refdes} (${result.lib_id})。`)
      },
    }),
    defineTool({
      name: 'connect_pins',
      description: 'Connect endpoint pairs with deterministic wire segments (L/J routing with collision '
        + 'avoidance). Optional net_name places a label on the first endpoint.',
      parameters: {
        endpoints: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          required: true,
          description: 'Endpoint pairs [ [a,b], ... ] with `refdes.pin` tokens (pin = physical number from pin_table); chained order is preserved.',
        },
        net_name: { type: 'string', description: 'Optional net label placed on the first endpoint.' },
        source_ids: { type: 'array', items: { type: 'string' }, description: 'Provenance group ids (optional).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            nets: { type: 'json' },
            wires: { type: 'json' },
          },
        },
        render: (_args, value) => text(JSON.stringify(value, null, 1)),
      },
      async execute(args: ConnectPinsArgs, exec) {
        const result = await host.perform(exec.agent, { tool: 'connect_pins', args }, (model) => connectPins(model, args))
        const projected = {
          nets: result.nets,
          wires: result.wires.map((wire) => ({ a: wire.a, b: wire.b, path: wire.path.map((point) => ({ x: point.x, y: point.y })) })),
        }
        return resultOf(projected, `已连接 ${args.endpoints.length} 对端点（${result.wires.length} 组 wire）。`)
      },
    }),
    defineTool({
      name: 'place_label',
      description: 'Place a net label (the only net-naming entry for local nets) at a pin endpoint.',
      parameters: {
        name: { type: 'string', required: true, description: 'Net name; must be unique.' },
        endpoint: { type: 'string', required: true, description: '`refdes.pin` endpoint token.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            net: NET_VIEW_SCHEMA,
          },
        },
        render: (_args, value) => text(JSON.stringify(value, null, 1)),
      },
      async execute(args: PlaceLabelArgs, exec) {
        const result = await host.perform(exec.agent, { tool: 'place_label', args }, (model) => placeLabel(model, args))
        return resultOf(result, `已放置标签 ${args.name}。`)
      },
    }),
    defineTool({
      name: 'place_power_symbol',
      description: 'Place a power symbol (GND/3V3/...) at a pin endpoint; the Value is the global net name.',
      parameters: {
        name: { type: 'string', required: true, description: 'Power net Value, e.g. GND, 3V3.' },
        endpoint: { type: 'string', required: true, description: '`refdes.pin` endpoint token.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            net: NET_VIEW_SCHEMA,
          },
        },
        render: (_args, value) => text(JSON.stringify(value, null, 1)),
      },
      async execute(args: PlacePowerArgs, exec) {
        const result = await host.perform(exec.agent, { tool: 'place_power_symbol', args }, (model) => placePowerSymbol(model, args))
        return resultOf(result, `已放置电源 ${args.name}。`)
      },
    }),
    defineTool({
      name: 'place_no_connect',
      description: 'Mark a pin endpoint as no-connect; the marker is persisted in the schematic and nc_kind is annotation-only.',
      parameters: {
        endpoint: { type: 'string', required: true, description: '`refdes.pin` endpoint token.' },
        nc_kind: { type: 'string', enum: ['intentional', 'product'], description: 'Reason annotation (not persisted).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => text(JSON.stringify(value, null, 1)),
      },
      async execute(args: { endpoint: string; nc_kind?: string }, exec) {
        const result = await host.perform(exec.agent, { tool: 'place_no_connect', args }, (model) => placeNoConnect(model, args))
        return result
      },
    }),
    defineTool({
      name: 'disconnect',
      description: 'Disconnect a pin from its net by removing every wire segment touching the pin point '
        + '(expected-optimistic concurrency: names current net view).',
      parameters: {
        endpoint: { type: 'string', required: true, description: '`refdes.pin` endpoint token.' },
        expected_net: { type: 'string', required: true, description: 'The net name the pin is expected to be on.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            nets: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => text(JSON.stringify(value, null, 1)),
      },
      async execute(args: DisconnectArgs, exec) {
        const result = await host.perform(exec.agent, { tool: 'disconnect', args }, (model) => disconnect(model, args))
        return resultOf(result, `已断开 ${args.endpoint}。`)
      },
    }),
    defineTool({
      name: 'set_property',
      description: 'Set a property (Reference/Value/Footprint) of an existing component; Reference rename '
        + 'checks uniqueness, power Value rename checks net-name uniqueness.',
      parameters: {
        refdes: { type: 'string', required: true, description: 'Target refdes.' },
        property: { type: 'string', enum: ['Reference', 'Value', 'Footprint'], required: true },
        value: { type: 'string', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => text(JSON.stringify(value, null, 1)),
      },
      async execute(args: SetPropertyArgs, exec) {
        const result = await host.perform(exec.agent, { tool: 'set_property', args }, (model) => setProperty(model, args))
        return result
      },
    }),
    defineTool({
      name: 'remove_component',
      description: 'Remove a component and its anchored labels, no-connect markers, and orphaned wire segments.',
      parameters: {
        refdes: { type: 'string', required: true, description: 'Refdes to remove (power symbols allowed).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            nets: { type: 'array', items: { type: 'string' } },
            removed: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => text(JSON.stringify(value, null, 1)),
      },
      async execute(args: RemoveComponentArgs, exec) {
        const result = await host.perform(exec.agent, { tool: 'remove_component', args }, (model) => removeComponent(model, args))
        return resultOf(result, `已移除 ${args.refdes}。`)
      },
    }),
  ]
}
