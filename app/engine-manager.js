
'use strict';

/* global logger */

const _ = require('lodash');
const url = require('url');
const H = require('higher');
const selectn = require('selectn');
const HigherDockerManager = require('higher-docker-manager');
const Engine = require('./engine');

const Label = {
    OrgGetlazyLazyEngineManagerOwner: 'org.getlazy.lazy.engine-manager.owner'
};

/**
 * Manages the engines running in lazy.
 */
class EngineManager
{
    constructor(config) {
        this._id = H.isNonEmptyString(config.id) ? config.id : 'default';
        this._config = config;
        this._container = null;
        this._network = null;
        this._volume = null;
        this._isRunning = false;
    }

    stop() {
        const self = this;

        return self._deleteAllEngines()
            .then(() => {
                self._isRunning = false;
            });
    }

    start() {
        //  1.  Check if lazy's network exists (unique ID read from envvars)
        //  1a. If the network exists, delete *all* containers within it.
        //      TODO: Delete recurively all containers and networks within lazy network.
        //  1b. If the network doesn't exist, create it and join lazy container to it.
        //  2.  Check if lazy's volume exists (unique ID read from envvars)
        //  2a. If the volume doesn't exist, create it.
        //  3.  Create new containers for all the engines and start them.

        const self = this;

        return Promise.all([
            HigherDockerManager.getOwnContainer().then(container => container.status()),
            self._findLazyNetworkOrCreateIt(),
            self._findLazyVolumeOrCreateIt()])
            .then((results) => {
                [self._container, self._network, self._volume] = results;
                return self._deleteAllEngines();
            })
            .then(() => self._joinContainerToNetwork())
            .then(() => self._installAllEngines())
            .then((engines) => {
                self._engines = engines;
            })
            .then(() => {
                //  Install ui if one is specified.
                if (_.isObject(self._config.ui)) {
                    return self._installEngine('ui', self._config.ui)
                        .then((uiEngine) => {
                            self._uiEngine = uiEngine;
                        });
                }

                return Promise.resolve();
            })
            .then(() => {
                self._isRunning = true;
            });
    }

    get isRunning() {
        return this._isRunning;
    }

    get engines() {
        return this._engines;
    }

    get uiEngine() {
        return this._uiEngine;
    }

    _installAllEngines() {
        const self = this;

        return Promise.all(_.map(self._config.engines,
            (engineConfig, engineName) => self._installEngine(engineName, engineConfig)));
    }

    _installEngine(engineName, engineConfig) {
        const self = this;

        const imageName = engineConfig.image;
        //  Get repository auth configuration either from engine or failing that from lazy level.
        let repositoryAuth = {};
        if (!_.isEmpty(engineConfig.repository_auth)) {
            repositoryAuth = engineConfig.repository_auth;
        } else if (!_.isEmpty(self._config.repository_auth)) {
            repositoryAuth = self._config.repository_auth;
        }
        //  Resolve the repository auth if its values are kept in the lazy's process environment.
        const resolvedRepositoryAuth = EngineManager._resolveRepositoryAuthValues(repositoryAuth);

        logger.info('Pulling image', imageName, 'for engine', engineName);
        return HigherDockerManager.pullImage(resolvedRepositoryAuth, imageName)
            .then(() => {
                const createEngineParams = {
                    Image: imageName,
                    Cmd: engineConfig.command ? engineConfig.command.split(' ') : undefined,
                    //  Engine's environment consists of the variables set in the config,
                    //  variables imported from lazy's environment and variables created by
                    //  lazy itself.
                    Env: _.union(
                        engineConfig.env,
                        _.map(engineConfig.import_env,
                            importEnvvar => `${importEnvvar}=${process.env[importEnvvar]}`),
                        [
                            `LAZY_HOSTNAME=${_.get(self._container, 'Config.Hostname')}`,
                            `LAZY_ENGINE_NAME=${engineName}`,
                            `LAZY_SERVICE_URL=${selectn('_config.service_url', self)}`,
                            `LAZY_PRIVATE_API_URL=${url.format({
                                protocol: 'http',
                                hostname: _.get(self._container, 'Config.Hostname'),
                                port: self._config.privateApiPort
                            })}`,
                            //  TODO: Fix this as special engines like UI don't follow this URL pattern.
                            `LAZY_ENGINE_URL=${selectn('_config.service_url', self)}/engine/${engineName}`,
                            `LAZY_VOLUME_NAME=${self._volume.Name}`,
                            'LAZY_VOLUME_MOUNT=/lazy',
                            `LAZY_ENGINE_SANDBOX_DIR=/lazy/sandbox/${engineName}`
                        ]),
                    HostConfig: {
                        //  When networking mode is a name of another network it's
                        //  automatically attached.
                        NetworkMode: self._network.Name,
                        //  We only allow volumes to be bound to host.
                        Binds: _.union(engineConfig.volumes, [
                            //  HACK: We hard-code the volume mount path to /lazy which is
                            //  known to all containers.
                            `${self._volume.Name}:/lazy`
                        ]),
                        RestartPolicy: {
                            Name: 'unless-stopped'
                        }
                    },
                    WorkingDir: engineConfig.working_dir,
                    Labels: {}
                };

                logger.info('Creating engine', {
                    engine: engineName,
                    network: self._network.Name,
                    volume: self._volume.Name
                });
                return HigherDockerManager.createContainer(createEngineParams);
            })
            .then(engineContainer =>
                engineContainer.start()
                    .then(() => new Engine(engineName, engineContainer, engineConfig))
            )
            .then(engine => engine.start().then(() => engine));
    }

    _findLazyVolumeOrCreateIt() {
        const self = this;

        return HigherDockerManager.getVolumesForLabel(
                Label.OrgGetlazyLazyEngineManagerOwner, self._id)
            .then((volumes) => {
                if (!_.isEmpty(volumes)) {
                    return _.head(volumes);
                }

                const volumeCreateParams = {
                    //  Name it after the unique ID.
                    name: `lazy-volume-${self._id}`,
                    Labels: {}
                };
                //  Add the label to later use it to find this container.
                volumeCreateParams.Labels[Label.OrgGetlazyLazyEngineManagerOwner] = self._id;

                return HigherDockerManager.createVolume(volumeCreateParams);
            });
    }

    /**
     * @return {Promise} Promise resolving with the network object or null.
     */
    getLazyNetwork() {
        return HigherDockerManager
            .getNetworksForLabel(Label.OrgGetlazyLazyEngineManagerOwner, this._id)
            .then((networks) => {
                if (!_.isEmpty(networks)) {
                    return _.head(networks);
                }

                return null;
            });
    }

    _findLazyNetworkOrCreateIt() {
        const self = this;

        return HigherDockerManager.getNetworksForLabel(
                Label.OrgGetlazyLazyEngineManagerOwner, self._id)
            .then((networks) => {
                if (!_.isEmpty(networks)) {
                    return _.head(networks);
                }

                const networkCreateParams = {
                    //  Name it after the unique ID.
                    name: `lazy-network-${self._id}`,
                    Labels: {}
                };
                //  Add the label to later use it to find this container.
                networkCreateParams.Labels[Label.OrgGetlazyLazyEngineManagerOwner] = self._id;

                return HigherDockerManager.createNetwork(networkCreateParams);
            });
    }

    _deleteAllEngines() {
        const self = this;

        //  Stop/wait/delete all containers in the lazy network except our own container.
        return HigherDockerManager.getContainersInNetworks([self._network.Name])
            .then(containers =>
                Promise.all(_.map(containers, (container) => {
                    logger.info('Stopping/waiting/deleting engine container',
                        _.head(container.Names));
                    if (container.id === self._container.id) {
                        return Promise.resolve();
                    }

                    return container.stop()
                        .then(() => container.wait())
                        .then(() => container.delete());
                }))
            );
    }

    _joinContainerToNetwork() {
        const self = this;

        //  Join lazy container to lazy network so that all engines are reachable.
        //  Names of the networks are keys in NetworkSettings.Networks structure.
        const lazyNetworksNames =
            _.keys(selectn('NetworkSettings.Networks', self._container));

        //  Check if the lazy container is already attached to lazy's network
        const alreadyAttachedToLazyNetwork = _.some(lazyNetworksNames,
            networkName => networkName === self._network.Name);
        if (alreadyAttachedToLazyNetwork) {
            return Promise.resolve();
        }

        //  Connect the lazy container to the lazy network.
        return self._network.connect({
            Container: self._container.id
        });
    }

    static _resolveRepositoryAuthValues(repositoryAuth) {
        const resolvedRepositoryAuth = {};
        //  Resolve the values of properties defined with _env suffix. Those properties instruct
        //  lazy to read their values from its own environment.
        _.forEach(repositoryAuth, (value, key) => {
            if (_.endsWith(key, '_env')) {
                resolvedRepositoryAuth[key.slice(0, key.length - '_env'.length)] =
                    process.env[value];
            } else {
                resolvedRepositoryAuth[key] = value;
            }
        });
        return resolvedRepositoryAuth;
    }
}

module.exports = EngineManager;
