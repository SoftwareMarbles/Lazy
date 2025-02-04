
'use strict';

/* global logger, describe, it, before, after, afterEach */

//  To set some properties we need `this` of `describe` and `it` callback functions.
// lazy ignore prefer-arrow-callback
// lazy ignore func-names

const td = require('testdouble');

const _ = require('lodash');
const assert = require('assert');
const HelperContainerManager = require('../app/helper-container-manager');

describe('HelperContainerManager', function () {
    afterEach(() => {
        td.reset();
    });

    describe('createContainer', function () {
        it('works', function () {
            td.when(td.replace(HelperContainerManager, '_pullImage')({}, 'test-image')).thenResolve();
            const containerId = 'test-container-id';
            const container = td.object(['start']);
            container.id = containerId;
            td.when(container.start()).thenResolve({ id: 'test-container-id' });
            td.when(td.replace(HelperContainerManager, '_createContainer')(td.matchers.argThat((params) => {
                assert.equal(params.Image, 'test-image');
                assert.deepEqual(_.get(params, 'HostConfig.Binds'), ['test-volume:/lazy']);
                assert.deepEqual(_.get(params, 'Labels'), {
                    'org.getlazy.lazy.engine-manager.owner.lazy-id': 'test-lazy-id'
                });
                return true;
            }))).thenResolve(container);

            return HelperContainerManager.createContainer('test-lazy-id', {}, 'test-image', 'test-volume')
                .then((createdContainerId) => {
                    assert.equal(createdContainerId, containerId);
                });
        });

        it('returns 500 on any error', function (done) {
            td.when(td.replace(HelperContainerManager, '_pullImage')({}, 'test-image')).thenResolve();
            const containerId = 'test-container-id';
            const container = td.object(['start']);
            container.id = containerId;
            td.when(container.start()).thenReject(new Error('test-error'));
            td.when(td.replace(HelperContainerManager, '_createContainer')(td.matchers.argThat((params) => {
                assert.equal(params.Image, 'test-image');
                assert.deepEqual(_.get(params, 'HostConfig.Binds'), ['test-volume:/lazy']);
                assert.deepEqual(_.get(params, 'Labels'), {
                    'org.getlazy.lazy.engine-manager.owner.lazy-id': 'test-lazy-id'
                });
                return true;
            }))).thenResolve(container);

            HelperContainerManager.createContainer('test-lazy-id', {}, 'test-image', 'test-volume')
                .catch((err) => {
                    console.log(err);
                    assert.equal(err.statusCode, 500);
                    assert.equal(err.message, 'create failed with test-error');
                    //  Use done to ensure that catch was invoked.
                    done();
                })
                .catch(done);
        });
    });

    describe('execInContainer', function () {
        it('works', function () {
            const containerId = 'test-container-id';
            const container = td.object(['status']);
            td.when(container.status()).thenResolve({
                Config: {
                    Labels: {
                        'org.getlazy.lazy.engine-manager.owner.lazy-id': 'true'
                    }
                }
            });
            container.id = containerId;

            td.when(td.replace(HelperContainerManager, '_getContainerForNameOrId')(containerId))
                .thenResolve(container);

            const execParams = {
                test: 'params'
            };

            td.when(td.replace(HelperContainerManager, '_execInContainer')(container, execParams))
                .thenResolve(['test', 'output']);

            return HelperContainerManager.execInContainer(containerId, execParams)
                .then((output) => {
                    assert.equal(output[0], 'test');
                    assert.equal(output[1], 'output');
                });
        });

        it('returns 500 on any error', function (done) {
            const containerId = 'test-container-id';
            const container = td.object(['status']);
            td.when(container.status()).thenResolve({
                Config: {
                    Labels: {
                        'org.getlazy.lazy.engine-manager.owner.lazy-id': 'true'
                    }
                }
            });
            container.id = containerId;

            td.when(td.replace(HelperContainerManager, '_getContainerForNameOrId')(containerId))
                .thenResolve(container);

            const execParams = {
                test: 'params'
            };

            td.when(td.replace(HelperContainerManager, '_execInContainer')(container, execParams))
                .thenReject(new Error('test-error'));

            HelperContainerManager.execInContainer(containerId, execParams)
                .catch((err) => {
                    assert.equal(err.statusCode, 500);
                    assert.equal(err.message, 'exec failed with test-error');
                    //  Use done to ensure that catch was invoked.
                    done();
                })
                .catch(done);
        });
    });

    describe('_findContainer', function () {
        it('returns 404 on unknown container ID', function (done) {
            const containerId = 'unknown-container-id';
            td.when(td.replace(HelperContainerManager, '_getContainerForNameOrId')(containerId))
                .thenResolve(null);

            HelperContainerManager._findContainer(containerId)
                .catch((err) => {
                    assert.equal(err.statusCode, 404);
                    //  Use done to ensure that catch was invoked.
                    done();
                })
                .catch(done);
        });
    });
});
