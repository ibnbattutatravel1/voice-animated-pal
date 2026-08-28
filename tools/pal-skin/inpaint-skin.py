import numpy as np, sys
from PIL import Image
SP=sys.argv[1]
AX,AY,CY = 0.146, 0.096, -0.016
FEATH_IN, FEATH_OUT = 0.62, 1.00

uv=np.fromfile(SP+'/uv.bin',dtype=np.float32).reshape(-1,2).astype(np.float64)
idx=np.fromfile(SP+'/idx.bin',dtype=np.uint32).reshape(-1,3)
q=np.load(SP+'/q.npy')
img=np.asarray(Image.open(SP+'/albedo.png').convert('RGB')).astype(np.float64)/255.0
H,W,_=img.shape
x,y,z=q[:,0],q[:,1],q[:,2]
e=(x/AX)**2+((y-CY)/AY)**2
onFace=(z>-0.45)&(z<0.45)
U=np.clip(uv[:,0],0,1); V=np.clip(uv[:,1],0,1)
col=img[np.clip((V*H).astype(int),0,H-1), np.clip((U*W).astype(int),0,W-1)]
lum=col@np.array([.299,.587,.114]); rb=col[:,0]-col[:,2]
A=np.array([0.1293,0.00107,-0.24845]); B=np.array([-0.81492,-0.11998,-0.21588])
depth=(A[0]+A[1]*x+A[2]*y+B[0]*x*x+B[1]*x*y+B[2]*y*y)-z
ring = onFace & (e>1.01) & (e<1.95) & (lum>0.30) & (rb<0.08) & (depth<0.02)
basis=lambda px,py: np.stack([np.ones_like(px),px,py,px*px,px*py,py*py],1)
coef=np.linalg.lstsq(basis(x[ring],y[ring]-CY), col[ring], rcond=None)[0]
print('annulus %d  residual rms %.4f'%(ring.sum(), np.sqrt(((basis(x[ring],y[ring]-CY)@coef-col[ring])**2).mean())))

PX=U*(W-1); PY=V*(H-1)
tris = idx[(onFace&(e<3.0))[idx].any(1)]
wmax=np.zeros((H,W)); qxT=np.zeros((H,W)); qyT=np.zeros((H,W))
for t in tris:
    x0,x1,x2=PX[t]; y0,y1,y2=PY[t]
    xmin=int(np.floor(min(x0,x1,x2)))-1; xmax=int(np.ceil(max(x0,x1,x2)))+1
    ymin=int(np.floor(min(y0,y1,y2)))-1; ymax=int(np.ceil(max(y0,y1,y2)))+1
    if xmax-xmin>128 or ymax-ymin>128: continue
    xmin=max(xmin,0); ymin=max(ymin,0); xmax=min(xmax,W-1); ymax=min(ymax,H-1)
    if xmax<xmin or ymax<ymin: continue
    d=((y1-y2)*(x0-x2)+(x2-x1)*(y0-y2))
    if abs(d)<1e-12: continue
    gx,gy=np.meshgrid(np.arange(xmin,xmax+1),np.arange(ymin,ymax+1))
    l0=((y1-y2)*(gx-x2)+(x2-x1)*(gy-y2))/d
    l1=((y2-y0)*(gx-x2)+(x0-x2)*(gy-y2))/d
    l2=1.0-l0-l1
    cov=(l0>=-0.7)&(l1>=-0.7)&(l2>=-0.7)
    if not cov.any(): continue
    qx=l0*x[t[0]]+l1*x[t[1]]+l2*x[t[2]]
    qy=l0*y[t[0]]+l1*y[t[1]]+l2*y[t[2]]
    ee=(qx/AX)**2+((qy-CY)/AY)**2
    m=cov&(ee<FEATH_OUT)
    if not m.any(): continue
    tt=np.clip((FEATH_OUT-ee[m])/(FEATH_OUT-FEATH_IN),0,1); wg=tt*tt*(3-2*tt)
    yy=gy[m]; xx=gx[m]
    better = wg > wmax[yy,xx]
    if better.any():
        yb=yy[better]; xb=xx[better]
        wmax[yb,xb]=wg[better]; qxT[yb,xb]=qx[m][better]; qyT[yb,xb]=qy[m][better]
hit=wmax>1e-4
fit=np.zeros((H,W,3))
fit[hit]=basis(qxT[hit],qyT[hit]-CY)@coef
res=img.copy()
res[hit]=img[hit]*(1-wmax[hit])[:,None]+np.clip(fit[hit],0,1)*wmax[hit][:,None]
Image.fromarray((np.clip(res,0,1)*255).astype(np.uint8)).save(SP+'/albedo_clean6.png')
Image.fromarray((wmax*255).astype(np.uint8)).save(SP+'/mask6.png')
print('written texels %d  (full-strength %d)'%(int(hit.sum()), int((wmax>0.99).sum())))
