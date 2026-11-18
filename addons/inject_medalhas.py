"""Inclui (ou atualiza) o complemento de medalhas nos três sites. Uso: python3 -I addons/inject_medalhas.py"""
import os,re
here=os.path.dirname(os.path.abspath(__file__));root=os.path.dirname(here)
add=open(os.path.join(here,'medalhas.html'),encoding='utf-8').read().strip()
for f in ('Desafio_de_Entrega.html','Labirinto_Inteligente.html','Carros_Autonomos.html'):
    p=os.path.join(root,f);s=open(p,encoding='utf-8').read()
    s=re.sub(r'\n?<!-- medalhas:inicio.*?<!-- medalhas:fim -->','',s,flags=re.S)
    s=s.replace('</body></html>','\n'+add+'\n</body></html>') if '</body></html>' in s else s.rstrip('\n')+'\n'+add+'\n'
    open(p,'w',encoding='utf-8').write(s);print('ok',f)
