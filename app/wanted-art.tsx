import {categories} from '@/backend/contracts';

// One approved illustration per category. Unknown categories use the box fallback.
const artwork:Record<typeof categories[number],string>={
 'Furniture':'furniture',
 'Electronics':'electronics',
 'Bicycles':'bicycles',
 'Home & garden':'home-garden',
 'Music':'music',
 'Books':'books',
 'Sports':'sports',
 'Other':'other',
};
export function WantedArt({category,detail=false}:{category:string;detail?:boolean}){
 const slug=Object.hasOwn(artwork,category)?artwork[category as keyof typeof artwork]:'other';
 return <div className={'wanted-art'+(detail?' wanted-art-detail':'')} aria-hidden="true">
  <img src={'/images/wanted/wanted-'+slug+'-v1.png'} alt="" width={1254} height={1254} loading={detail?'eager':'lazy'} decoding="async"/>
 </div>;
}
