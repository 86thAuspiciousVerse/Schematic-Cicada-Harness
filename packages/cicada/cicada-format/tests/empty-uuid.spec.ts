// 空 uuid 容错回归：引擎 saveback / 本包 writer 的 (pin "1" (uuid )) 空节点
// 任何时候都应可读（M1c：AI 工具 inspect/spawn 读文件不被 malformed 拦截）。
import { describe, expect, it } from 'vitest'
import { parse } from '../src/read.ts'

describe('empty optional uuid tolerance', () => {
  it('parses a workspace file with empty (uuid ) pins and wires with uuids', () => {
    const text = `(kicad_sch (version 20260803) (generator "cicada") (generator_version "0.1")
  (uuid 9dbc27ae-e2e5-48d4-88f9-e5a0902d9ad4)
  (lib_symbols
    (symbol "R" (pin_numbers (hide yes)) (pin_names (offset 0)) (property "Reference" "R" (at 2.032 0 90)) (property "Value" "R" (at 0 0 90)) (symbol "R_0_1" (rectangle (start -0.38 0.89) (end 0.38 -0.89))) (symbol "R_1_1" (pin passive line (at 0.00 1.27 270) (length 2.54) (name "P1") (number "1")) (pin passive line (at 0.00 -1.27 90) (length 2.54) (name "P2") (number "2"))))
  )
  (symbol (lib_id "cicada:R") (at 25.40 25.40 0) (unit 1)
    (uuid d7e55f8c-5932-4efb-95cf-c00d1096502e)
    (property "Reference" "R1" (at 25.40 25.40 0))
    (property "Value" "10k" (at 25.40 25.40 0))
    (pin "1" (uuid ))
    (pin "2" (uuid )))
  (wire (pts (xy 25.40 26.67) (xy 30.50 26.67)) (uuid f78d659b-994d-4bbf-8f47-2d32c00cb5f7))
)`
    const model = parse(text)
    expect(model.symbols[0]?.pins[0]?.uuid).toBe('')
    expect(model.wires[0]?.uuid).toBe('f78d659b-994d-4bbf-8f47-2d32c00cb5f7')
    })
})
