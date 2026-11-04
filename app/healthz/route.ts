// Liveness only: never expose account, configuration or database information.
export function GET(){return Response.json({status:'ok'},{headers:{'Cache-Control':'no-store'}});}
