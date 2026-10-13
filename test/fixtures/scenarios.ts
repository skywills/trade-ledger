const encoder = new TextEncoder();

function csv(value: string): Uint8Array {
  return encoder.encode(value);
}

export const fixtures = {
  spread:
    csv(`Account,Symbol,AssetClass,Expiry,Strike,Put/Call,DateTime,Quantity,TradePrice,NetCash,FifoPnlRealized,Notes/Codes,IBOrderID,IBExecID,TradeID,Multiplier,OpenDateTime,RowType
SIM-A,AXON,OPT,2026-10-16,470,P,2026-09-03 10:00:00,+1,14.02,-1402.23006,,O,OPEN-SPREAD,EXEC-A-1,TRADE-A-1,100,,execution
SIM-A,AXON,OPT,2026-10-16,480,P,2026-09-03 10:00:00,-1,16.87,1686.7318978,,O,OPEN-SPREAD,EXEC-A-2,TRADE-A-2,100,,execution
SIM-A,AXON,OPT,2026-10-16,470,P,2026-09-25 11:00:00,-1,38.20,3820.8776968,2418.647637,C,CLOSE-SPREAD,EXEC-A-3,TRADE-A-3,100,,execution
SIM-A,AXON,OPT,2026-10-16,480,P,2026-09-25 11:00:00,+1,45.57,-4557.04028,-2870.308382,C,CLOSE-SPREAD,EXEC-A-4,TRADE-A-4,100,,execution
SIM-A,AXON,OPT,2026-10-16,470,P,2026-09-25 11:00:00,0,,0,2418.647637,ST,,,,100,2026-09-03 10:00:00,lot
SIM-A,AXON,OPT,2026-10-16,480,P,2026-09-25 11:00:00,0,,0,-2870.308382,ST,,,,100,2026-09-03 10:00:00,lot
`),
  assignment:
    csv(`Account,Symbol,AssetClass,Expiry,Strike,Put/Call,DateTime,Quantity,TradePrice,NetCash,Notes/Codes,PositionActionID,TradeID,Multiplier
SIM-B,BIDU,OPT,2026-10-02,105,P,2026-09-24 15:00:00,+1,0,0,A;C,119280546,TRADE-B-1,100
SIM-B,BIDU,STK,,,+,2026-09-24 15:00:00,+100,105,-10500,A;O,119280546,TRADE-B-2,1
SIM-B,BIDU,OPT,2026-10-02,100,P,2026-09-25 15:00:00,-1,0,0,C;Ex,119326170,TRADE-B-3,100
SIM-B,BIDU,STK,,,+,2026-09-25 15:00:00,-100,100,9999.7745,C;Ex,119326170,TRADE-B-4,1
`),
  partialFills:
    csv(`Account,Symbol,AssetClass,DateTime,Quantity,TradePrice,NetCash,IBOrderID,IBExecID,TradeID
SIM-C,XYZ,OPT,2026-09-03 10:00:00,+2,1.25,-250,ORDER-C,EXEC-C-1,TRADE-C-1
SIM-C,XYZ,OPT,2026-09-03 10:00:00,+2,1.25,-250,ORDER-C,EXEC-C-2,TRADE-C-2
`),
  roll: csv(`Account,Symbol,AssetClass,Expiry,Strike,Put/Call,DateTime,Quantity,TradePrice,NetCash,Notes/Codes,IBOrderID,IBExecID,TradeID
SIM-C,XYZ,OPT,2026-10-16,100,P,2026-09-03 10:00:00,+1,2,-200,C,ORDER-ROLL,EXEC-ROLL-CLOSE,TRADE-ROLL-CLOSE
SIM-C,XYZ,OPT,2026-11-20,95,P,2026-09-03 10:00:00,-1,3,300,O,ORDER-ROLL,EXEC-ROLL-OPEN,TRADE-ROLL-OPEN
`),
  reduced:
    csv(`Account,Symbol,AssetClass,Expiry,Strike,Put/Call,DateTime,Quantity,TradePrice,NetCash,Notes/Codes,TradeID,Multiplier
SIM-B,BIDU,OPT,2026-10-02,105,P,2026-09-24 15:00:00,+1,0,0,,TRADE-B-1,100
SIM-B,BIDU,STK,,,STK,2026-09-24 15:00:00,+100,105,-10500,,TRADE-B-2,1
SIM-B,BIDU,OPT,2026-10-02,100,P,2026-09-25 15:00:00,-1,0,0,,TRADE-B-3,100
SIM-B,BIDU,STK,,,STK,2026-09-25 15:00:00,-100,100,9999.7745,,TRADE-B-4,1
`),
} satisfies Record<string, Uint8Array>;
