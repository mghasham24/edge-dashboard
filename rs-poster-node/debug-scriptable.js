const AUTH = 'DJ4YAdpv!GMkNDzO3!0221b47b-a2c3-4be0-a6e0-0b9ea757058e';
const UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

function rsHeaders() {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://www.realapp.com',
    'Referer': 'https://www.realapp.com/',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'real-device-uuid': UUID,
    'real-device-type': 'desktop_web',
    'real-version': '31',
    'real-request-token': Math.random().toString(36).slice(2, 18),
    'real-auth-info': AUTH,
  };
}

try {
  let posReq = new Request('https://web.realapp.com/predictions/openpositions');
  posReq.headers = rsHeaders();
  let posData = await posReq.loadJSON();
  console.log('response:', JSON.stringify(posData).slice(0, 300));
} catch(e) {
  console.log('ERROR:', e.message);
}

Script.complete();
