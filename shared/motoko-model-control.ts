export interface ModelSaveInput {
 seatId:string;logicalId:string;expectedModel:string;model:string;reason:string;
}
export interface ModelSaveResult {
 outcome:"saved"|"no-op"|"conflict"|"unknown"|"refused";
 rigId:string;seatId:string;logicalId:string;targetModel:string;
 changed:boolean|null;savedModel:string|null;readback:"known"|"unknown";
}
