import { createContext, useContext } from "react";
export interface View {
  page:"overview"|"new"|"run"|"studio";
  runId?:string;versionId?:string;nodeId?:string;memberId?:string;questionId?:string;anchor?:string;
  tab?:"chat"|"team"|"progress";
  pane?:"discuss"|"graph"|"start";
}
export const firstView:View={page:"overview"};
export const Navigation=createContext({view:firstView,go:(_v:View)=>{}});
export const useNavigation=()=>useContext(Navigation);
