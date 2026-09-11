import { createRoot } from 'react-dom/client';
import App from '@/App';
import '@/index.css';

const data = await (await fetch(`data.json?${Date.now()}`)).json();
createRoot(document.getElementById('root')).render(<App data={data} />);
