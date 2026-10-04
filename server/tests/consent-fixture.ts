import { randomToken } from '../src/services/crypto.js';
import type { SsoModel, AuthorizationRequest } from '../src/models/ssoModel.js';
export async function consentedCode(model:SsoModel,input:AuthorizationRequest,scope='identity:read profile email') {
  const request=await model.beginAuthorization({...input,scope,state:randomToken()});
  const result=await model.decideConsent(request,input.sessionId,input.userId,true,scope.split(' '));
  return new URL(result.redirectTo).searchParams.get('code')!;
}
