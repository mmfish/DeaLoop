export async function seedDemo(db:D1Database){
 const owner='thread-demo';await db.prepare('INSERT OR IGNORE INTO users VALUES(?,?,?)').bind(owner,'DeaLoop examples',Date.now()).run();
 const seeds=[
 ['chair','for_sale','A simple stool with a story','Furniture',8500,'Good','Oakland, CA','local_pickup','A simple wooden stool. Solid frame, light wear on the seat. A sample listing to explore DeaLoop.'],
 ['bike','for_sale','Your next city ride','Bicycles',12000,'Good','Berkeley, CA','local_pickup','Comfortable upright bicycle with working brakes and gears. Medium frame. Example listing, not an actual offer.'],
 ['camera','for_sale','For the everyday photographer','Electronics',22500,'Good','San Francisco, CA','either','A well-loved camera, ready for its next chapter. Battery included. This is an illustrative sample, not a verified item for sale.'],
 ['guitar','wanted','An acoustic guitar to learn on','Music',10000,'Good','Oakland, CA','local_pickup','Looking for a comfortable beginner guitar. All strings intact, no neck damage. Budget up to $100. This is a sample Wanted post.'],
 ['lamp','for_sale','A warmer corner of home','Home & garden',3500,'Good','Alameda, CA','local_pickup','A small table lamp for a reading nook. Example listing; no real seller or transaction.'],
 ['books','for_sale','Poetry for a quiet afternoon','Books',2000,'Fair','Berkeley, CA','either','A pre-loved paperback for a quiet afternoon. Some annotations and a worn cover. Sample listing.'],
 ['desk','wanted','Small desk, big ideas','Furniture',15000,'Good','San Francisco, CA','local_pickup','Seeking a small wooden desk for a home office, under 48 inches wide. Minor cosmetic wear is fine. Example request.'],
 ['coffee','for_sale','A pair of everyday coffee cups','Home & garden',4500,'Good','Oakland, CA','either','A pair of coffee cups looking for a new home. Clean and well cared for. Illustrative sample only.'],
 ];
 await db.batch(seeds.map((s,i)=>{const [id,type,title,category,price,condition,location,delivery,description]=s;return db.prepare("INSERT OR IGNORE INTO posts(id,owner_id,actor,type,title,description,category,price,condition,location,delivery,image,demo,created_at,idempotency_key,request_hash) VALUES(?,?,'demo',?,?,?,?,?,?,?,?,?,1,?,?,?)").bind('demo-'+id,owner,type,title,description,category,price,condition,location,delivery,type==='wanted'?null:'/images/'+id+'.jpg',Date.now()-i*3600000,'seed-'+id,'seed');}));
}
