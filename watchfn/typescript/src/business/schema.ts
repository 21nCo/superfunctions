import {getAlertSchema} from '../alerts/schema';
import type { TableSchema } from '@superfunctions/db';
export const BUSINESS_DEFINITIONS = 'watchfn_business_definitions';
/** Additive migration; hosts create the table before using stored business definitions. */
export function getBusinessSchema(): Record<string, TableSchema> {
 return {...getAlertSchema(),[BUSINESS_DEFINITIONS]:{modelName:BUSINESS_DEFINITIONS,fields:{
  id:{type:'string',required:true,unique:true}, namespace:{type:'string',required:true},
  kind:{type:'string',required:true}, name:{type:'string',required:true},
  payload:{type:'json',jsonStorageType:'json-text',required:true},
 },indexes:[{name:'watchfn_business_namespace',fields:['namespace','kind','name']}]}};
}
