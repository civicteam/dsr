const _ = require('lodash');
const { isValidGlobalIdentifier, VCCompat: VC } = require('@identity.com/credential-commons');

const { services, initServices } = require('./services');

const config = services.container.Config;
const signer = services.container.Signer;

const SCHEMA_VERSION = '1';

const VALID_OPERATORS = [
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$mod',
  '$in',
  '$nin',
  '$not',
  '$all',
  '$or',
  '$nor',
  '$and',
  '$regex',
  '$where',
  '$elemMatch',
  '$exists',
];

const VALID_AGGREGATORS = [
  '$limit',
  '$max',
  '$min',
  '$last',
  '$first',
  '$sort',
];

const VALIDATION_MODE = {
  ADVANCED: 'ADVANCED',
  SIMPLE: 'SIMPLE',
};

const isLocal = url => (url.match('(http://|https://)?(localhost|127.0.0.*)') !== null);

const isValidEvidenceChannelDetails = (channelDetails) => {
  let result = true;
  result = _.includes(['application/json', 'image/*', 'multipart-from'], channelDetails.accepts);
  result = result && _.includes(['put', 'post'], channelDetails.method);
  result = result && (!_.isEmpty(channelDetails.url) && (isLocal(channelDetails.url) || _.startsWith(channelDetails.url, 'https')));
  return result;
};

const isValidCredentialMeta = (credentialItem, constraints) => {
  const credentialMeta = VC.getCredentialMeta(credentialItem);
  return VC.isMatchCredentialMeta(credentialMeta, constraints);
};

/**
 * Class for generating Scope Requests
 */
class ScopeRequest {
  /**
   * Runs the credential 'isMatch' validation against each constraint individually and returns the failing constraints
   * @param credentialItems - A list of credentialItems to check
   * @param request - Original ScopeRequest
   * @param checkCredentialMeta - If true, check credential meta
   * @return {{ credentialId: string, identifier: string, constraint: object }[]} a list of failed claims
   */
  static async getFailingConstraints(credentialItems, request, checkCredentialMeta = false) {
    const requestedItems = _.get(request, 'credentialItems');

    if (_.isEmpty(requestedItems)) {
      throw new Error('invalid scopeRequest object');
    }
    if (_.isEmpty(credentialItems)) {
      throw new Error('empty credentialItems param');
    }
    // eslint-disable-next-line consistent-return
    const result = (await Promise.all(_.map(requestedItems, async (requestedItem) => {
      const credentialItem = _.find(credentialItems, cred => (cred.identifier === requestedItem.credential || cred.identifier === requestedItem.identifier));
      if (!credentialItem) {
        return null;
      }

      // If is a presentation `credentialItem.granted` nor empty accept partial
      const verifiableCredential = await VC.fromJSON(credentialItem, !!credentialItem.granted);

      const constraints = _.get(requestedItem, 'constraints');
      const failedClaims = (constraints.claims || []).map((claimFilter) => {
        const singleConstraint = _.get(_.set(_.cloneDeep(requestedItem), 'constraints.claims', [claimFilter]), 'constraints');
        if (!verifiableCredential.isMatch(singleConstraint)) {
          return { credentialId: credentialItem.id, identifier: credentialItem.identifier, constraint: claimFilter };
        }
        return null;
      }).filter(item => !!item); // filter out nulls
      if (checkCredentialMeta) {
        Object.entries(constraints.meta || {}).forEach(([key, value]) => {
          const singleMeta = _.get(_.set(_.cloneDeep(requestedItem), 'constraints.meta', { [key]: value }), 'constraints');
          if (!isValidCredentialMeta(credentialItem, singleMeta)) {
            failedClaims.push({
              credentialId: credentialItem.id,
              identifier: credentialItem.identifier,
              constraint: _.assign({ path: `meta.${key}` }, value),
            });
          }
        });
      }
      return failedClaims;
    }))).filter(item => !!item); // filter out nulls
    return _.flatten(result);
  }

  /**
   *
   * @param credentialItems - A list of credentialItems to check
   * @param request - Original ScopeRequest
   * @param checkCredentialMeta - If true, check credential meta
   * @return {boolean}
   */
  static async credentialsMatchesRequest(credentialItems, request, checkCredentialMeta = false) {
    let result = true;
    const requestedItems = _.get(request, 'credentialItems');

    if (_.isEmpty(requestedItems)) {
      throw new Error('invalid scopeRequest object');
    }
    if (_.isEmpty(credentialItems)) {
      throw new Error('empty credentialItems param');
    }
    // eslint-disable-next-line consistent-return
    await _.reduce(requestedItems, async (promise, requestedItem) => {
      await promise;
      const credentialItem = _.find(credentialItems, cred => (cred.identifier === requestedItem.credential || cred.identifier === requestedItem.identifier));
      if (!credentialItem) {
        // no need to continue breaking and returning false
        result = false;
        return false;
      }

      // If is a presentation `credentialItem.granted` nor empty accept partial
      const verifiableCredential = await VC.fromJSON(credentialItem, !!credentialItem.granted);

      const constraints = _.get(requestedItem, 'constraints');
      const match = verifiableCredential.isMatch(constraints);
      const matchCredentialMeta = (!checkCredentialMeta) || isValidCredentialMeta(credentialItem, constraints);
      if (!match || !matchCredentialMeta) {
        // no need to continue breaking and returning false
        result = false;
        return false;
      }
    }, Promise.resolve());
    return result;
  }

  /**
   * Validate the constraints of an Scope Request
   * @param constraint of an Scope Request
   * @returns {boolean} true|false
   */
  static validateConstraint(constraint) {
    const operatorKeys = _.keys(constraint);

    if (operatorKeys.length !== 1) {
      throw new Error('Invalid Constraint Object - only one operator is allowed');
    }
    if (!_.includes(VALID_OPERATORS, operatorKeys[0])) {
      throw new Error(`Invalid Constraint Object - ${operatorKeys[0]} is not a valid operator`);
    }

    if (_.isNil(constraint[operatorKeys[0]])) {
      throw new Error('Invalid Constraint Object - a constraint value is required');
    }

    return true;
  }

  /**
   * Validate the constraints of an Scope Request
   * @param {Object} filter of an aggregation in the Scope Request
   * @returns {boolean} true|false
   */
  static validateAggregationFilter(filter) {
    const operatorKeys = _.keys(filter);

    if (operatorKeys.length !== 1) {
      throw new Error('Invalid Constraint Object - only one operator is allowed');
    }
    if (!_.includes(VALID_AGGREGATORS, operatorKeys[0])) {
      throw new Error(`Invalid Aggregate Object - ${operatorKeys[0]} is not a valid filter`);
    }

    if (_.isNil(filter[operatorKeys[0]])) {
      throw new Error('Invalid Constraint Object - a constraint value is required');
    }

    return true;
  }

  /**
   * Check o credential commons if it is an valid global identifier
   * @param identifier
   * @returns {*}
   */
  static async isValidCredentialItemIdentifier(identifier) {
    return isValidGlobalIdentifier(identifier);
  }

  /**
   * DSR definition has to reference all IDVs by DIDs
   *
   * To encode a DID for an Ethereum address, simply prepend did:ethr:
   * eg:
   * did:ethr:0xf3beac30c498d9e26865f34fcaa57dbb935b0d74
   *
   * @param issuer the content of the string in the meta of the scope request
   * @returns {boolean} true for the pattern to be accepted, false otherwise
   */
  static isValidCredentialIssuer(issuer) {
    return !!issuer;
  }

  /**
   * Validate the credential items part of an scope request
   * @param credentialItems the array of credential items needed for an dsr
   * @returns {boolean} true|false sucess|failure
   */
  static async validateCredentialItems(credentialItems) {
    await _.reduce(credentialItems, async (promise, item) => {
      await promise;

      if (_.isString(item)) {
        const valid = await ScopeRequest.isValidCredentialItemIdentifier(item);
        if (!valid) {
          throw new Error(`${item} is not valid CredentialItem identifier`);
        }
      } else {
        if (_.isEmpty(item.identifier)) {
          throw new Error('CredentialItem identifier is required');
        }

        const valid = await ScopeRequest.isValidCredentialItemIdentifier(item.identifier);
        if (!valid) {
          throw new Error(`${item.identifier} is not valid CredentialItem identifier`);
        }

        if (!_.isEmpty(item.constraints)) {
          // Meta section
          if (!_.isEmpty(item.constraints.meta)) {
            if (!item.constraints.meta.issuer) {
              throw new Error('The META issuer constraint is required');
            }

            if (!ScopeRequest.isValidCredentialIssuer(item.constraints.meta.issuer.is.$eq)) {
              throw new Error(`${item.constraints.meta.issuer.is.$eq} is not a valid issuer`);
            }

            if (item.constraints.meta.issued) {
              ScopeRequest.validateConstraint(item.constraints.meta.issued.is);
            }

            if (item.constraints.meta.expiry) {
              ScopeRequest.validateConstraint(item.constraints.meta.expiry.is);
            }

            if (item.identifier.startsWith('claim-') && item.constraints.meta.noClaims) {
              throw new Error('Cannot ask for Claims and also have the flag noClaimss equals true');
            }
          }
          // Claims section
          if (!_.isEmpty(item.constraints.claims)) {
            _.forEach(item.constraints.claims, (claim) => {
              if (_.isEmpty(claim.path)) {
                throw new Error('Claim path is required');
              }
              if (_.isEmpty(claim.is)) {
                throw new Error('Claim constraint is required');
              }
              ScopeRequest.validateConstraint(claim.is);
            });
          }
        }

        if (!_.isEmpty(item.aggregate)) {
          _.forEach(item.aggregate, (aggregationFilter) => {
            ScopeRequest.validateAggregationFilter(aggregationFilter);
          });
        }
      }
    }, Promise.resolve());

    return true;
  }

  static validateChannelsConfig(channelsConfig) {
    if (!channelsConfig.eventsURL) {
      throw new Error('eventsURL is required');
    }

    if (!isLocal(channelsConfig.eventsURL)
      && !_.startsWith(channelsConfig.eventsURL, 'https')) {
      throw new Error('only HTTPS is supported for eventsURL');
    }

    if (channelsConfig.payloadURL
      && !isLocal(channelsConfig.payloadURL)
      && !_.startsWith(channelsConfig.payloadURL, 'https')) {
      throw new Error('only HTTPS is supported for payloadURL');
    }

    if (channelsConfig.evidences) {
      if (channelsConfig.evidences.idDocumentFront && !isValidEvidenceChannelDetails(channelsConfig.evidences.idDocumentFront)) {
        throw new Error('invalid idDocumentFront channel configuration');
      }
      if (channelsConfig.evidences.idDocumentBack && !isValidEvidenceChannelDetails(channelsConfig.evidences.idDocumentBack)) {
        throw new Error('invalid idDocumentBack channel configuration');
      }
      if (channelsConfig.evidences.selfie && !isValidEvidenceChannelDetails(channelsConfig.evidences.selfie)) {
        throw new Error('invalid selfie channel configuration');
      }
    }

    return true;
  }

  static validateAppConfig(appConfig) {
    if (_.isEmpty(appConfig.id)) {
      throw new Error('app.id is required');
    }

    if (_.isEmpty(appConfig.name)) {
      throw new Error('app.name is required');
    }

    if (_.isEmpty(appConfig.logo)) {
      throw new Error('app.logo is required');
    }

    if (!_.startsWith(appConfig.logo, 'https')) {
      throw new Error('only HTTPS is supported for app.logo');
    }

    if (_.isEmpty(appConfig.description)) {
      throw new Error('app.description is required');
    }

    if (_.isEmpty(appConfig.primaryColor)) {
      throw new Error('app.primaryColor is required');
    }

    if (_.isEmpty(appConfig.secondaryColor)) {
      throw new Error('app.secondaryColor is required');
    }

    return true;
  }

  static validatePartnerConfig(partnerConfig) {
    if (_.isEmpty(partnerConfig.id)) {
      throw new Error('partner.id is required');
    }

    if (_.isEmpty(partnerConfig.signingKeys) || _.isEmpty(partnerConfig.signingKeys.xpub) || _.isEmpty(partnerConfig.signingKeys.xprv)) {
      throw new Error('Partner public and private signing keys are required');
    }
    return true;
  }

  static validateAuthentication(authentication) {
    if (!_.isBoolean(authentication)) {
      throw new Error('Invalid value for authentication');
    }
    return true;
  }

  static async create(uniqueId, requestedItems, channelsConfig, appConfig, partnerConfig, authentication = true, mode = 'ADVANCED') {
    let credentialItems = [].concat(requestedItems);

    const valid = await ScopeRequest.validateCredentialItems(credentialItems);
    if (valid) {
      credentialItems = _.cloneDeep(credentialItems);
    }

    return new ScopeRequest(uniqueId, requestedItems, credentialItems, channelsConfig, appConfig, partnerConfig, authentication, mode);
  }

  constructor(uniqueId, requestedItems, credentialItems, channelsConfig, appConfig, partnerConfig, authentication = true, mode = 'ADVANCED') {
    this.version = SCHEMA_VERSION;
    if (!uniqueId) {
      throw Error('uniqueId is required');
    }
    this.id = uniqueId;
    this.requesterInfo = {};

    if (ScopeRequest.validateAuthentication(authentication)) {
      this.authentication = authentication;
    }

    this.timestamp = (new Date()).toISOString();

    this.credentialItems = credentialItems;

    if (channelsConfig && ScopeRequest.validateChannelsConfig(channelsConfig)) {
      this.channels = channelsConfig;
    } else {
      const channels = {
        eventsURL: `${config.channels.baseEventsURL}/${uniqueId}`,
        payloadURL: `${config.channels.basePayloadURL}/${uniqueId}`,
      };
      if (ScopeRequest.validateChannelsConfig(channels)) {
        this.channels = channels;
      }
    }

    if (appConfig && ScopeRequest.validateAppConfig(appConfig)) {
      this.requesterInfo.app = appConfig;
    } else if (ScopeRequest.validateAppConfig(config.app)) {
      this.requesterInfo.app = config.app;
    }

    if (partnerConfig && ScopeRequest.validatePartnerConfig(partnerConfig)) {
      const newConfig = Object.assign({}, config);
      newConfig.partner = partnerConfig;
      initServices(newConfig);
      this.requesterInfo.requesterId = partnerConfig.id;
    } else if (ScopeRequest.validatePartnerConfig(config.partner)) {
      this.requesterInfo.requesterId = config.partner.id;
    }

    this.mode = mode;
  }

  toJSON() {
    return _.omit(this, ['partnerConfig']);
  }
}

function buildSignedRequestBody(scopeRequest) {
  const { xprv, xpub } = services.container.Config.partner.signingKeys;
  const signatureResponse = signer.sign(scopeRequest, xprv);
  return {
    payload: scopeRequest,
    signature: signatureResponse.signature,
    algorithm: signatureResponse.algorithm,
    xpub,
  };
}

function verifySignedRequestBody(body, pinnedXpub) {
  if (!body.payload) {
    throw new Error('Request must have a payload object');
  }
  if (!body.signature) {
    throw new Error('Request must have a signature');
  }
  if (!body.xpub) {
    throw new Error('Request must have a public key');
  }
  if (pinnedXpub && (pinnedXpub !== body.xpub)) {
    throw new Error('Request public key not match');
  }
  return signer.verify(body.payload, body.signature, body.xpub);
}

module.exports = {
  ScopeRequest, buildSignedRequestBody, verifySignedRequestBody, VALIDATION_MODE,
};
