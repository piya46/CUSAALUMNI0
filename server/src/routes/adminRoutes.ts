import { Router } from 'express';
import { requireAuth, requireAdmin, csrfProtection } from '../middleware/security.js';
import * as controller from '../controllers/adminController.js';

import * as access from '../controllers/serviceAccessController.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin, csrfProtection);
adminRouter.get('/overview', controller.overview);
adminRouter.get('/users', controller.users);
adminRouter.delete('/users/:id', controller.deleteUser);
adminRouter.get('/allowlist', controller.allowlist);
adminRouter.post('/allowlist', controller.createAllowedEmail);
adminRouter.delete('/allowlist/:id', controller.deleteAllowedEmail);
adminRouter.get('/applications', controller.applications);
adminRouter.post('/applications', controller.createApplication);
adminRouter.delete('/applications/:id', controller.deleteApplication);
adminRouter.get('/api-keys', controller.apiKeys);
adminRouter.post('/api-keys', controller.createApiKey);
adminRouter.delete('/api-keys/:id', controller.deleteApiKey);
adminRouter.get('/audit', controller.auditLog);

adminRouter.patch('/users/:id/profile', access.editProfile);
adminRouter.get('/applications/:applicationId/roles', access.roles);
adminRouter.post('/applications/:applicationId/roles', access.createRole);
adminRouter.patch('/applications/:applicationId/roles/:roleId', access.editRole);
adminRouter.delete('/applications/:applicationId/roles/:roleId', access.deleteRole);
adminRouter.get('/applications/:applicationId/members', access.members);
adminRouter.put('/applications/:applicationId/members/:userId', access.saveMember);
adminRouter.delete('/applications/:applicationId/members/:userId', access.deleteMember);
