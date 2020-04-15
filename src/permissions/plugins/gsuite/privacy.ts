import { groupssettings_v1 } from 'googleapis';

const internal = {
  whoCanJoin: 'INVITED_CAN_JOIN',
  whoCanViewMembership: 'ALL_IN_DOMAIN_CAN_VIEW',
  allowExternalMembers: 'true',
  whoCanPostMessage: 'ALL_IN_DOMAIN_CAN_POST',
  allowWebPosting: 'true',
  whoCanLeaveGroup: 'NONE_CAN_LEAVE',
  membersCanPostAsTheGroup: 'false',
  whoCanContactOwner: 'ALL_IN_DOMAIN_CAN_CONTACT',
  whoCanApproveMembers: 'NONE_CAN_APPROVE',
  whoCanModerateMembers: 'NONE',
  whoCanModerateContent: 'ALL_MEMBERS',
  whoCanAssistContent: 'ALL_MEMBERS',
};

export const privacySettings: Record<'internal' | 'external', groupssettings_v1.Schema$Groups> = {
  internal,
  external: {
    ...internal,
    whoCanPostMessage: 'ANYONE_CAN_POST',
  },
};
