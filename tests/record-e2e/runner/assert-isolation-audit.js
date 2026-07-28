function guardError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertIsolationAudit(audit) {
  if (!audit || !audit.networkAudit || audit.networkAudit.auditPerformed !== true
    || audit.networkAudit.guardInstalled !== true) {
    throw guardError('ISOLATION_AUDIT_NOT_EXECUTED', 'Network isolation audit was not executed');
  }
  if (audit.networkAudit.realNetworkRequests !== 0
    || audit.networkAudit.unknownFakeRouteRequests !== 0) {
    throw guardError(
      'AUTOMATION_NETWORK_GUARD_ERROR',
      'Network Guard detected a forbidden request'
    );
  }
  if (!audit.storageAudit || audit.storageAudit.auditPerformed !== true
    || audit.storageAudit.fakeWxBrandVerifiedStart !== true
    || audit.storageAudit.fakeWxBrandVerifiedEnd !== true) {
    throw guardError('ISOLATION_AUDIT_NOT_EXECUTED', 'Storage isolation audit was not executed');
  }
  if (audit.storageAudit.realWxStorageCalls !== 0) {
    throw guardError(
      'AUTOMATION_STORAGE_GUARD_ERROR',
      'Runner touched a real or host wx Storage API'
    );
  }
  if (!audit.hostFilesystemAudit || audit.hostFilesystemAudit.auditPerformed !== true
    || audit.hostFilesystemAudit.guardInstalled !== true) {
    throw guardError('ISOLATION_AUDIT_NOT_EXECUTED', 'Host filesystem audit was not executed');
  }
  if (audit.hostFilesystemAudit.hostFilesystemStorageCalls !== 0) {
    throw guardError(
      'AUTOMATION_STORAGE_GUARD_ERROR',
      'Runner attempted a host filesystem write'
    );
  }
  return true;
}

module.exports = {
  assertIsolationAudit,
  guardError
};
