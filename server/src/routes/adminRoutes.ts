import { Router } from 'express';
import { requireAuth, requireAdmin, requireRecentAdminMfa, requireFreshMfa, rateLimit, csrfProtection } from '../middleware/security.js';
import * as controller from '../controllers/adminController.js';

import * as reset from '../controllers/mfaResetController.js';
import * as access from '../controllers/serviceAccessController.js';
import * as policy from '../controllers/servicePolicyController.js';
import { readQueueSettings, saveQueueSettings } from '../controllers/waitingRoomController.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin, requireRecentAdminMfa, csrfProtection);
adminRouter.get('/overview', controller.overview);
adminRouter.get('/users', controller.users);
adminRouter.get('/service-users', controller.serviceUsers);
adminRouter.delete('/users/:id', controller.deleteUser);
adminRouter.delete('/users/:id/sessions', requireFreshMfa, controller.revokeUserSessions);
adminRouter.get('/allowlist', controller.allowlist);
adminRouter.post('/allowlist', controller.createAllowedEmail);
adminRouter.delete('/allowlist/:id', controller.deleteAllowedEmail);
adminRouter.get('/applications', controller.applications);
adminRouter.post('/applications', controller.createApplication);
adminRouter.delete('/applications/:id', controller.deleteApplication);
adminRouter.get('/applications/:id/queue', readQueueSettings);
adminRouter.put('/applications/:id/queue', saveQueueSettings);
adminRouter.get('/applications/:id/sharing',controller.sharingPolicy);
adminRouter.put('/applications/:id/sharing',controller.saveSharingPolicy);
adminRouter.get('/api-keys', controller.apiKeys);
adminRouter.post('/api-keys', controller.createApiKey);
adminRouter.delete('/api-keys/:id', controller.deleteApiKey);
adminRouter.get('/audit', controller.auditLog);

adminRouter.patch('/users/:id/profile', access.editProfile);
adminRouter.get('/applications/:applicationId/roles', access.roles);
adminRouter.get('/applications/:applicationId/access-policy',policy.readPolicy);
adminRouter.put('/applications/:applicationId/access-policy',policy.savePolicy);
adminRouter.get('/applications/:applicationId/invitations',policy.invitations);
adminRouter.post('/applications/:applicationId/invitations',policy.invite);
adminRouter.delete('/applications/:applicationId/invitations',policy.uninvite);
adminRouter.get('/applications/:applicationId/lifecycle-preview',policy.preview);
adminRouter.post('/applications/:applicationId/roles', access.createRole);
adminRouter.patch('/applications/:applicationId/roles/:roleId', access.editRole);
adminRouter.delete('/applications/:applicationId/roles/:roleId', access.deleteRole);
adminRouter.get('/applications/:applicationId/members', access.members);
adminRouter.put('/applications/:applicationId/members/:userId', access.saveMember);
adminRouter.delete('/applications/:applicationId/members/:userId', access.deleteMember);

adminRouter.get('/mfa-resets',reset.list);
adminRouter.get('/mfa-resets/:id/evidence',requireFreshMfa,rateLimit('evidence-view',30,60),reset.evidence);
adminRouter.post('/mfa-resets/:id/decision',requireFreshMfa,reset.decide);
