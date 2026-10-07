import React,{useEffect,useRef} from 'react';

/** Native dialog supplies modal focus trapping, Escape and focus restoration. */
export function Modal({title,busy=false,onClose,children}:{title:string;busy?:boolean;onClose:()=>void;children:React.ReactNode}){
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const element=dialog.current!;element.showModal();return()=>{element.close();};},[]);
  return <dialog ref={dialog} className="modal" aria-labelledby="modal-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onClick={event=>{if(event.target===dialog.current&&!busy){const rect=dialog.current.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)onClose();}}}>
    <div className="section-head"><h2 id="modal-title">{title}</h2><button type="button" disabled={busy} onClick={onClose} aria-label="关闭弹窗">关闭</button></div>{children}
  </dialog>;
}
