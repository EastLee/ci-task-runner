const path = require('path');
const fsp = require('../lib/fs-promise');
const defaultsDeep = require('lodash.defaultsdeep');
const promiseTask = require('../lib/promise-task');
const Repository = require('../lib/repository');
const Loger = require('../lib/loger');
const DEFAULT = require('./config/config.default.json');
const CACHE_DEFAULT = require('./config/cache.default.json');
const PACKAGE = require('../package.json');

const parse = require('./parse');
const build = require('./build');


/**
 * 支持增量与多进程的构建任务调度器
 * @param   {Object}            options                         @see config/config.default.json
 * @param   {Object[]|string[]} options.tasks                   任务目录列表
 * @param   {string}            options.tasks[].name            任务目标名（相对）
 * @param   {string[]}          options.tasks[].dependencies    任务依赖目录或文件（相对），继承 options.dependencies
 * @param   {Object}            options.tasks[].program         任务构建器设置，继承 options.program
 * @param   {string[]}          options.dependencies            任务公共依赖（相对）
 * @param   {string}            options.cache                   缓存文件输出路径（相对）
 * @param   {string}            options.repository              仓库类型，可选 git|svn
 * @param   {number}            options.parallel                最大并发进程数
 * @param   {boolean}           options.force                   是否强制全部构建
 * @param   {Object|string}     options.program                 构建器设置
 * @param   {string}            options.program.command         构建器运行命令
 * @param   {string}            options.program.options         构建器子进程配置 @see childProcess.exec() options 
 * @param   {string}            context                         工作目录（绝对路径）
 * @return  {Promise}
 */
const taskRunner = (options = {}, context = process.cwd()) => {
    const time = Date.now();

    options = defaultsDeep({}, options, DEFAULT);
    options.cache = path.resolve(context, options.cache);

    const loger = new Loger();
    const cache = {};

    loger.log('░░', `${PACKAGE.name}:`, `v${PACKAGE.version}`);

    const repository = new Repository(options.cache, options.repository, 'revision');

    return promiseTask.serial([


        // 将外部输入的配置转换成内部任务描述队列
        parse(options, context),


        // 检查任务是否有变更
        tasks => {
            cache.tasks = {};
            return Promise.all(tasks.map(task => {
                return Promise.all([

                    repository.watch(task.path),
                    ...task.dependencies.map(lib => repository.watch(lib.path))

                ]).then(([modCommit, ...libCommits]) => {

                    let modChanged = modCommit[0] !== modCommit[1];
                    let libChanged = libCommits.filter(libCommit => libCommit[0] !== libCommit[1]).length !== 0;
                    task.dirty = options.force || modChanged || libChanged;

                    cache.tasks[task.name] = {
                        path: path.relative(options.cache, task.path),
                        dirty: task.dirty
                    };

                    return task;
                });
            }));
        },


        // 过滤未修改的版本
        tasks => {
            const loger = new Loger([
                { color: 'gray' },
                null,
                { minWidth: 16, color: 'green', textDecoration: 'underline' }
            ]);
            return tasks.filter(task => {
                if (task.dirty) {
                    return true
                } else {
                    loger.log('░░', `${PACKAGE.name}:`, task.name, '[no changes]');
                    return false;
                }
            });
        },


        // 运行构建器
        tasks => {
            return build(tasks, options.parallel);
        },


        // 更新资源索引文件
        () => {
            return fsp.readFile(options.cache, 'utf8')
                .then(json => defaultsDeep({}, JSON.parse(json)))
                .catch(() => defaultsDeep({}, CACHE_DEFAULT))
                .then(oldAssets => defaultsDeep(cache, oldAssets))
                .then(cache => {
                    let json = JSON.stringify(cache, null, 2);
                    return fsp.writeFile(options.cache, json, 'utf8').then(() => cache);
                });
        },


        // 保存当前已编译的版本信息
        // 必须构建完才保存版本信息，否则构建失败后下一次可能不会重新构建
        cache => {
            return repository.save().then(() => cache);
        }

    ]).then(results => {
        let timeEnd = Date.now() - time;
        loger.log('░░', `${PACKAGE.name}:`, `${timeEnd}ms`);
        return results[results.length - 1];
    });
};

module.exports = taskRunner;