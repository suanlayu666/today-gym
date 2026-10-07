import type {FlowStage,FlowMetrics} from './flow.ts';
import type {PlainReport} from './plain-report.ts';
import type {Dataset} from './types.ts';
import type {mainnetMetrics} from '../server/mainnet-metrics.ts';
import {formatUnits} from 'ethers';

export function exactTokenAmount(raw:string,decimals:number){const [whole,fraction]=formatUnits(raw,decimals).split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction===undefined?'':'.'+fraction);}

export type ResearchMetrics=ReturnType<typeof mainnetMetrics>;
export type ResearchRun={
  id:string;datasetId:string;asOfBlock:number;status:'investigating'|'reviewing'|'complete'|'partial';
  stages:FlowStage[];startedAt:string;finishedAt?:string;error?:string;
  risk?:'no-signal'|'attention'|'insufficient'|'disputed';
  online:{status:'pending'|'verified'|'failed';checkedAt?:string;chainId?:number;cutoffHash?:string;txHash?:string;rpcHosts?:string[];scope:string};
};
export type ResearchCase={
  id:string;role:'anomaly'|'control';name:string;dataset:Dataset;metrics:ResearchMetrics;
  summary:PlainReport;run?:ResearchRun;anchor:{txHash:string;from:string;to:string;amount:string;blockNumber:number};
  previousInvestigation?:{generatedAt:string;toolCalls:number;headline:string};
};
export type ComparisonCase={id:string;title:string;origin:'synthetic';metrics:FlowMetrics;ruleResult:string;normalExplanation:string;investigationQuestion:string;unknowns:string;expected:string};
export type ResearchOverview={cases:ResearchCase[];comparisons:ComparisonCase[];modelConfigured:boolean;error?:string};
