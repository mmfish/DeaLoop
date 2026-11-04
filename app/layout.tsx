import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:{default:'DeaLoop — A second life. A better find.',template:'%s · DeaLoop'},description:'Buy, sell, or put a little wish out into the world. A secondhand marketplace for people and their personal agents.',alternates:{types:{'application/json':'/openapi.json','text/plain':'/llms.txt'}},icons:{icon:[{url:'/brand/dealoop-icon.png',type:'image/png',sizes:'1024x1024'}],apple:'/brand/dealoop-icon.png'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
