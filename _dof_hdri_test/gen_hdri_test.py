import re

def extract_data(path):
    s = open(path, encoding='utf-8').read()
    m = re.search(r'window\.HDRI_DATA\["(\w+)"\]="([^"]+)"', s)
    return m.group(1), m.group(2)

k1, d1 = extract_data(r'C:\CH_ZAWU\vibecoding工具\GLB预览文件生成\assets\hdri\urban.js')
k2, d2 = extract_data(r'C:\CH_ZAWU\vibecoding工具\GLB预览文件生成\assets\hdri\blue.js')
print("urban len:", len(d1), "blue len:", len(d2))

html = '''<!DOCTYPE html><html><head><meta charset="utf-8"><title>HDRI 预设差异测试</title>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
<style>html,body{margin:0;background:#000}#viewer{width:400px;height:400px}</style></head>
<body><div id="viewer"></div>
<script type="module">
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
const DATA = { "urban": "URBAN_DATA", "blue": "BLUE_DATA" };
const TYPE = { "urban": "exr", "blue": "hdr" };
const params = new URLSearchParams(location.search);
const key = params.get('hdri') || 'urban';
const container = document.getElementById('viewer');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
camera.position.set(0, 0, 3.2);
const renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
renderer.setSize(400,400,false); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
container.appendChild(renderer.domElement);
const pmrem = new THREE.PMREMGenerator(renderer); pmrem.compileEquirectangularShader();
const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 64), new THREE.MeshStandardMaterial({ color:0xffffff, metalness:1.0, roughness:0.08 }));
scene.add(ball);
const box = new THREE.Mesh(new THREE.BoxGeometry(1.2,0.1,1.2), new THREE.MeshStandardMaterial({ color:0xcccccc, metalness:0.0, roughness:0.9 }));
box.position.y=-1.05; scene.add(box);
scene.add(new THREE.AmbientLight(0xffffff,0.15));
const dl = new THREE.DirectionalLight(0xffffff,0.4); dl.position.set(2,4,3); scene.add(dl);
const loader = (TYPE[key] === 'exr') ? new EXRLoader() : new RGBELoader();
loader.load(DATA[key], (tex)=>{
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const env = pmrem.fromEquirectangular(tex).texture;
  scene.environment = env;
  ball.material.envMap = env; ball.material.needsUpdate = true;
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const px = new Uint8Array(4*100*100);
  gl.readPixels(150,150,100,100,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let r=0,g=0,b=0,n=100*100;
  for(let i=0;i<px.length;i+=4){ r+=px[i]; g+=px[i+1]; b+=px[i+2]; }
  window.__stats = { key, mean:[Math.round(r/n),Math.round(g/n),Math.round(b/n)] };
  window.__ready = true;
}, undefined, (e)=>{ window.__ready=true; window.__stats={key, error:String(e)}; });
</script></body></html>'''

html = html.replace('URBAN_DATA', d1).replace('BLUE_DATA', d2)
open('test_hdri.html','w',encoding='utf-8').write(html)
print("written test_hdri.html", len(html), "bytes")
